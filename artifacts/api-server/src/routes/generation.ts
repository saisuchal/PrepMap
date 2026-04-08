import { Router, type IRouter } from "express";
import {
  CreateConfigBody,
  UploadConfigFilesBody,
  UploadConfigFilesParams,
  TriggerGenerationParams,
  GetGenerationStatusParams,
  GetGenerationStatusResponse,
  PublishConfigParams,
} from "../api-zod";
import {
  db,
  configsTable,
  nodesTable,
  configQuestionsTable,
  configUnitLinksTable,
  subjectsTable,
  unitLibraryTable,
  unitTopicsTable,
  unitSubtopicsTable,
} from "../db";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "crypto";
import { runGeneration, getProgress, buildLaneAConfigPackage, isLikelyQuestionText } from "../lib/generator";
import { requireAdmin } from "../middleware/adminAuth";
import { askAI } from "../lib/ai";
import { repairBrokenFormulaBullets } from "../lib/textFormatting";

const router: IRouter = Router();

type CheapImportProgress = {
  configId: string;
  status: "idle" | "processing" | "complete" | "error";
  stage: "validating" | "saving_structure" | "saving_questions" | "finalizing" | "done";
  processedQuestions: number;
  totalQuestions: number;
  message: string;
  warnings: string[];
  saved?: {
    units: number;
    questions: number;
    reusedExplanations: number;
    generatedExplanations: number;
  };
  error?: string;
};

const cheapImportProgressMap = new Map<string, CheapImportProgress>();

function getCheapImportProgress(configId: string): CheapImportProgress {
  return (
    cheapImportProgressMap.get(configId) ?? {
      configId,
      status: "idle",
      stage: "validating",
      processedQuestions: 0,
      totalQuestions: 0,
      message: "Idle",
      warnings: [],
    }
  );
}

function setCheapImportProgress(configId: string, updates: Partial<CheapImportProgress>) {
  const current = getCheapImportProgress(configId);
  cheapImportProgressMap.set(configId, {
    ...current,
    ...updates,
    configId,
  });
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function toSlug(value: string): string {
  const normalized = normalizeText(value);
  return normalized ? normalized.replace(/\s+/g, "_") : "untitled";
}

function isInstructionalAnswerPlaceholder(answer: string): boolean {
  const raw = String(answer || "").trim();
  if (!raw) return true;
  return /use a short exam answer|use a structured exam answer|one-line definition|one tiny real-world example/i.test(raw);
}

function summarizeQuestionFocus(questionText: string, fallback = "the asked concept"): string {
  const text = String(questionText || "")
    .replace(/\s+/g, " ")
    .replace(/^\d+\s*[.)-]?\s*/, "")
    .trim();
  if (!text) return fallback;
  const lead = text.split(/[?.!]/)[0]?.trim() || text;
  const words = lead.split(" ").filter(Boolean).slice(0, 10);
  return words.join(" ") || fallback;
}

function buildExamReadyFallbackAnswer(
  questionText: string,
  markType: "Foundational" | "Applied",
  topicTitle?: string,
  subtopicTitle?: string,
): string {
  const focus = subtopicTitle || topicTitle || summarizeQuestionFocus(questionText);
  if (markType === "Applied") {
    return [
      `This question is about ${focus}.`,
      "Apply the standard concept or formula in clear steps.",
      "Show key intermediate work, then write the final result clearly.",
      "Add one tiny practical context if relevant.",
    ].join("\n");
  }
  return [
    `${focus} is the key concept asked here.`,
    "State the core definition or formula briefly.",
    "Apply it directly and present the final answer clearly.",
  ].join("\n");
}

function explanationKey(unitTitle: string, topicTitle: string, subtopicTitle: string): string {
  return `${normalizeText(unitTitle)}|${normalizeText(topicTitle)}|${normalizeText(subtopicTitle)}`;
}

async function generateSubtopicExplanation(
  subject: string,
  unitTitle: string,
  topicTitle: string,
  subtopicTitle: string,
): Promise<string> {
  const prompt = `You are an exam prep writer for "${subject}".

Write a crisp explanation for:
- Unit: ${unitTitle}
- Topic: ${topicTitle}
- Subtopic: ${subtopicTitle}

Requirements:
- 60-100 words
- Simple, clean, fast to revise
- Include: what it is, why it matters, one short example/use-case
- Use short paragraphs or bullets
- Use very simple English for first-year beginners
- Keep sentences short and direct
- Avoid jargon unless absolutely necessary
- Return plain text only.`;

  const response = await askAI(
    "You generate concise exam-ready explanations.",
    prompt,
    900,
  );

  return repairBrokenFormulaBullets(response.trim());
}

async function generateTopicExplanation(
  subject: string,
  unitTitle: string,
  topicTitle: string,
): Promise<string> {
  const prompt = `You are an exam prep writer for "${subject}".

Write a crisp topic explanation for:
- Unit: ${unitTitle}
- Topic: ${topicTitle}

Requirements:
- 50-90 words
- Fast to revise, clear and practical
- Mention core idea + why it matters
- Use very simple English for first-year beginners
- Keep sentences short and direct
- Avoid jargon unless absolutely necessary
- Return plain text only.`;

  const response = await askAI(
    "You generate concise exam-ready topic explanations.",
    prompt,
    700,
  );

  return repairBrokenFormulaBullets(response.trim());
}

async function loadReusableExplanationMap(
  subject: string,
  _currentConfigId: string,
): Promise<Map<string, string>> {
  const normalizedSubject = normalizeText(subject);
  if (!normalizedSubject) return new Map();

  const [subjectRow] = await db
    .select({ id: subjectsTable.id })
    .from(subjectsTable)
    .where(eq(subjectsTable.normalizedName, normalizedSubject))
    .limit(1);
  if (!subjectRow) return new Map();

  const units = await db
    .select({
      id: unitLibraryTable.id,
      unitTitle: unitLibraryTable.unitTitle,
    })
    .from(unitLibraryTable)
    .where(eq(unitLibraryTable.subjectId, subjectRow.id));
  if (units.length === 0) return new Map();

  const unitById = new Map(units.map((u) => [u.id, u.unitTitle]));
  const unitIds = units.map((u) => u.id);

  const topics = await db
    .select({
      id: unitTopicsTable.id,
      unitLibraryId: unitTopicsTable.unitLibraryId,
      title: unitTopicsTable.title,
    })
    .from(unitTopicsTable)
    .where(inArray(unitTopicsTable.unitLibraryId, unitIds));
  if (topics.length === 0) return new Map();

  const topicById = new Map(topics.map((t) => [t.id, t]));
  const topicIds = topics.map((t) => t.id);

  const subtopics = await db
    .select({
      unitTopicId: unitSubtopicsTable.unitTopicId,
      title: unitSubtopicsTable.title,
      explanation: unitSubtopicsTable.explanation,
    })
    .from(unitSubtopicsTable)
    .where(inArray(unitSubtopicsTable.unitTopicId, topicIds));

  const reuse = new Map<string, string>();
  for (const sub of subtopics) {
    const explanation = String(sub.explanation || "").trim();
    if (!explanation) continue;
    const topic = topicById.get(sub.unitTopicId);
    if (!topic) continue;
    const unitTitle = unitById.get(topic.unitLibraryId);
    if (!unitTitle) continue;

    const key = explanationKey(unitTitle, topic.title, sub.title);
    if (!reuse.has(key)) reuse.set(key, explanation);
  }

  return reuse;
}

type ImportUnit = {
  title: string;
  topics: Array<{
    title: string;
    explanation?: string;
    subtopics: Array<{
      title: string;
      explanation: string;
    }>;
  }>;
};

type ImportQuestion = {
  markType: "Foundational" | "Applied";
  question: string;
  answer: string;
  unitTitle: string;
  topicTitle: string;
  subtopicTitle: string;
  isStarred?: boolean;
};

function parseImportBody(body: unknown): { units: ImportUnit[]; questions: ImportQuestion[] } {
  const unitsRaw = Array.isArray((body as any)?.units) ? (body as any).units : [];
  const questionsRaw = Array.isArray((body as any)?.questions) ? (body as any).questions : [];

  const units: ImportUnit[] = unitsRaw
    .map((u: any) => ({
      title: String(u?.title || "").trim(),
      topics: (Array.isArray(u?.topics) ? u.topics : []).map((t: any) => ({
      title: String(t?.title || "").trim(),
        explanation: String(t?.explanation || "").trim(),
        subtopics: (Array.isArray(t?.subtopics) ? t.subtopics : []).map((s: any) => ({
          title: String(s?.title || "").trim(),
          explanation: String(s?.explanation || "").trim(),
        })).filter((s: any) => s.title),
      })).filter((t: any) => t.title && t.subtopics.length > 0),
    }))
    .filter((u: any) => u.title && u.topics.length > 0);

  const questions: ImportQuestion[] = questionsRaw
    .map((q: any) => ({
      markType: q?.markType === "Applied" ? "Applied" : "Foundational",
      question: String(q?.question || "").trim(),
      answer: "",
      unitTitle: String(q?.unitTitle || "").trim(),
      topicTitle: String(q?.topicTitle || "").trim(),
      subtopicTitle: String(q?.subtopicTitle || "").trim(),
      isStarred: Boolean(q?.isStarred),
    }))
    .map((q: ImportQuestion, idx: number) => {
      const rawAnswer = String((questionsRaw[idx] as any)?.answer || "").trim();
      const answer = isInstructionalAnswerPlaceholder(rawAnswer)
        ? buildExamReadyFallbackAnswer(q.question, q.markType, q.topicTitle, q.subtopicTitle)
        : rawAnswer;
      return { ...q, answer };
    })
    .filter((q: ImportQuestion) => q.question && q.answer && isLikelyQuestionText(q.question));

  return { units, questions };
}

function normalizeUploadedObjectPath(rawPath: string): string {
  let path = rawPath.trim();

  // Support clients that accidentally send "objects/..." without a leading slash.
  if (path.startsWith("objects/")) {
    path = `/${path}`;
  }

  // Guard against accidental double-prefixing like "/objects//objects/<id>".
  path = path.replace(/^\/objects\/+objects\//, "/objects/");
  path = path.replace(/^\/supabase\/+supabase\//, "/supabase/");

  return path;
}

function isSupportedStoragePath(path: string): boolean {
  return path.startsWith("/objects/") || path.startsWith("/supabase/");
}

router.post("/configs", requireAdmin, async (req, res) => {
  try {
    const body = CreateConfigBody.parse(req.body);
    const userId = (req as any).userId as string;

    const [existing] = await db
      .select()
      .from(configsTable)
      .where(and(
        eq(configsTable.universityId, body.universityId),
        eq(configsTable.year, body.year),
        eq(configsTable.branch, body.branch),
        eq(configsTable.subject, body.subject),
        eq(configsTable.exam, body.exam),
      ))
      .limit(1);

    if (existing) {
      if (existing.status === "disabled") {
        await db
          .update(configsTable)
          .set({ status: "draft" })
          .where(eq(configsTable.id, existing.id));

        const [revived] = await db
          .select()
          .from(configsTable)
          .where(eq(configsTable.id, existing.id))
          .limit(1);

        res.status(200).json({
          id: revived.id,
          universityId: revived.universityId,
          year: revived.year,
          branch: revived.branch,
          subject: revived.subject,
          exam: revived.exam,
          status: revived.status,
          createdBy: revived.createdBy,
          createdAt: revived.createdAt?.toISOString(),
          syllabusFileUrl: revived.syllabusFileUrl ?? null,
          paperFileUrls: revived.paperFileUrls ?? null,
          revived: true,
        });
        return;
      }

      res.status(409).json({
        error: "A config for this subject, semester, branch, and exam already exists.",
      });
      return;
    }

    const id = randomUUID().substring(0, 8);

    await db.insert(configsTable).values({
      id,
      universityId: body.universityId,
      year: body.year,
      branch: body.branch,
      subject: body.subject,
      exam: body.exam,
      status: "draft",
      createdBy: userId,
    });

    const [config] = await db
      .select()
      .from(configsTable)
      .where(eq(configsTable.id, id))
      .limit(1);

    res.status(201).json({
      id: config.id,
      universityId: config.universityId,
      year: config.year,
      branch: config.branch,
      subject: config.subject,
      exam: config.exam,
      status: config.status,
      createdBy: config.createdBy,
      createdAt: config.createdAt?.toISOString(),
      syllabusFileUrl: config.syllabusFileUrl ?? null,
      paperFileUrls: config.paperFileUrls ?? null,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to create config");
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

router.post("/configs/:id/upload", requireAdmin, async (req, res) => {
  try {
    const { id } = UploadConfigFilesParams.parse(req.params);
    const body = UploadConfigFilesBody.parse(req.body);
    const syllabusFileUrl = normalizeUploadedObjectPath(body.syllabusFileUrl);
    const paperFileUrls = body.paperFileUrls.map((url) => normalizeUploadedObjectPath(url));
    if (paperFileUrls.length > 1) {
      res.status(400).json({ error: "Only one replica paper is allowed per config. Uploading again will replace it." });
      return;
    }

    if (!isSupportedStoragePath(syllabusFileUrl)) {
      res.status(400).json({ error: "syllabusFileUrl must start with /objects/ or /supabase/" });
      return;
    }
    for (const url of paperFileUrls) {
      if (!isSupportedStoragePath(url)) {
        res.status(400).json({ error: "paperFileUrls must start with /objects/ or /supabase/" });
        return;
      }
    }

    const [config] = await db
      .select()
      .from(configsTable)
      .where(eq(configsTable.id, id))
      .limit(1);

    if (!config) {
      res.status(404).json({ error: "Config not found" });
      return;
    }

    await db
      .update(configsTable)
      .set({
        syllabusFileUrl,
        paperFileUrls,
      })
      .where(eq(configsTable.id, id));

    res.json({ success: true });
  } catch (error) {
    req.log.error({ err: error }, "Failed to upload config files");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/configs/:id/generate", requireAdmin, async (req, res) => {
  try {
    const { id } = TriggerGenerationParams.parse(req.params);

    const [config] = await db
      .select()
      .from(configsTable)
      .where(eq(configsTable.id, id))
      .limit(1);

    if (!config) {
      res.status(404).json({ error: "Config not found" });
      return;
    }

    const linkedUnits = await db
      .select({ id: configUnitLinksTable.id })
      .from(configUnitLinksTable)
      .where(eq(configUnitLinksTable.configId, id));

    if (!config.syllabusFileUrl && linkedUnits.length === 0) {
      res.status(400).json({ error: "No syllabus uploaded and no reusable units selected" });
      return;
    }

    runGeneration(id).catch((err) => {
      req.log.error({ err, configId: id }, "Background generation failed");
    });

    res.status(202).json({ success: true });
  } catch (error) {
    req.log.error({ err: error }, "Failed to trigger generation");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/configs/:id/generation-status", async (req, res) => {
  try {
    const { id } = GetGenerationStatusParams.parse(req.params);
    const progress = getProgress(id);

    const response = GetGenerationStatusResponse.parse({
      configId: progress.configId,
      status: progress.status,
      progress: progress.progress,
      total: progress.total,
      currentStep: progress.currentStep,
      error: progress.error,
    });

    res.json(response);
  } catch (error) {
    req.log.error({ err: error }, "Failed to get generation status");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/configs/:id/publish", requireAdmin, async (req, res) => {
  try {
    const { id } = PublishConfigParams.parse(req.params);

    const [config] = await db
      .select()
      .from(configsTable)
      .where(eq(configsTable.id, id))
      .limit(1);

    if (!config) {
      res.status(404).json({ error: "Config not found" });
      return;
    }

    const newStatus = config.status === "live" ? "draft" : "live";
    await db
      .update(configsTable)
      .set({ status: newStatus })
      .where(eq(configsTable.id, id));

    res.json({ success: true });
  } catch (error) {
    req.log.error({ err: error }, "Failed to toggle publish status");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/configs/:id/cheap/lane-a", requireAdmin, async (req, res) => {
  try {
    const { id } = TriggerGenerationParams.parse(req.params);
    const pkg = await buildLaneAConfigPackage(id);

    const effectiveStarTarget = pkg.replicaQuestions.length > 0 ? pkg.totalStarTarget : 0;
    const starredReplica = pkg.replicaQuestions.filter((q) => q.isStarred).length;
    const remainingStarsNeeded = Math.max(0, effectiveStarTarget - starredReplica);
    const remainingQuestionsNeeded = Math.max(0, pkg.totalQuestionTarget - pkg.replicaQuestions.length);

    const masterPrompt = `You are generating exam-prep content for this config.

STRICT OUTPUT: Return ONLY valid JSON in this exact shape:
{
  "units": [
    {
      "title": "Unit title",
      "topics": [
        {
          "title": "Topic title",
          "explanation": "50-90 word crisp topic explanation with one tiny example/use-case",
          "subtopics": [
            { "title": "Subtopic title", "explanation": "60-100 word crisp explanation with one tiny example/use-case" }
          ]
        }
      ]
    }
  ],
  "questions": [
    {
      "markType": "Foundational" | "Applied",
      "question": "Question text",
      "answer": "Concise exam-ready answer",
      "unitTitle": "Unit title",
      "topicTitle": "Topic title",
      "subtopicTitle": "Subtopic title",
      "isStarred": true | false
    }
  ]
}

CONSTRAINTS:
- Keep the same unit/topic/subtopic structure.
- Include all mandatory replica questions exactly as given below.
- Total questions required: ${pkg.totalQuestionTarget}
- Total starred required: ${effectiveStarTarget}
- Replica questions already included: ${pkg.replicaQuestions.length}
- Remaining questions to generate: ${remainingQuestionsNeeded}
- Remaining starred to allocate across non-replica questions: ${remainingStarsNeeded}
- Answers must be concise and cleanly formatted.
- Answers must be actual exam-ready answers, not answer-writing instructions.
- Never use placeholder text like "Use a short exam answer..." or "Use a structured exam answer...".
- No duplicates.
- Include only real exam questions (no metadata lines like Bloom levels K1/K2, Course Outcomes, Part/Section headers, Q.No tables, or instructions like "Answer any...").
- Return exactly one JSON object and nothing else.
- Do not wrap output in markdown/code fences.
- Ensure JSON is syntactically valid:
  - Escape inner double quotes inside string values (use \\").
  - No trailing commas.
  - Use true/false for booleans (not strings).
- questions array must contain exactly ${pkg.totalQuestionTarget} items.
- Exactly ${effectiveStarTarget} items must have "isStarred": true.
- unitTitle/topicTitle/subtopicTitle in each question must exactly match titles from STRUCTURE.
- markType must be only "Foundational" or "Applied".
- Keep mandatory replica questions verbatim for question text.
- Topic/subtopic explanations must be snappy and beginner-friendly.
- Each topic/subtopic explanation must include one tiny concrete example/use-case.
- Explanations must use short paragraphs (not one dense block).
- Tone requirement (strict): beginner-friendly simple English only.
- Foundational answers: 2-4 short lines, very direct, and include one tiny real-world example when it helps understanding.
- Applied answers: 4-7 short lines with a tiny practical example.
- Never write one dense paragraph answer; use line breaks and simple bullets/steps where useful.
- Decide contextually:
  - If the subject/question is technical and code genuinely improves clarity, you may include a short fenced code block.
  - If the subject/question is non-technical, avoid code blocks and use short step-wise explanation with a tiny practical example.
- If original marks are known from replica/sections, map marks to labels as:
  1-3 marks => Foundational, 4+ marks => Applied.

FINAL SELF-CHECK BEFORE OUTPUT (must pass all):
1) JSON parses without error.
2) units preserve the same hierarchy from STRUCTURE.
3) questions.length === ${pkg.totalQuestionTarget}
4) count(isStarred=true) === ${effectiveStarTarget}
5) all mandatory replica questions are present.
6) no duplicate question text after normalization.
If any check fails, fix it before returning final JSON.

GENERATION PROCEDURE (follow in order):
Step A) Copy STRUCTURE into "units" exactly, then add explanations (60-100 words each).
Step B) Start "questions" by inserting all MANDATORY_REPLICA_QUESTIONS first.
Step C) Add exactly ${remainingQuestionsNeeded} new questions so total becomes ${pkg.totalQuestionTarget}.
Step D) Keep total starred at exactly ${effectiveStarTarget}. Mandatory replicas are already starred.
Step E) Re-check JSON validity and all counts before final answer.

HARD FAILURE RULES:
- Never return "questions": [].
- Never return fewer or more than ${pkg.totalQuestionTarget} questions.
- Never omit mandatory replica questions.
- Never change question text of mandatory replica questions.

STRUCTURE:
${JSON.stringify(pkg.structure, null, 2)}

MANDATORY_REPLICA_QUESTIONS:
${JSON.stringify(pkg.replicaQuestions, null, 2)}
`;

    res.json({
      success: true,
      configId: pkg.configId,
      subject: pkg.subject,
      structure: pkg.structure,
      replicaQuestions: pkg.replicaQuestions,
      warnings: pkg.warnings,
      replicaExtraction: pkg.replicaExtraction,
      totalQuestionTarget: pkg.totalQuestionTarget,
      totalStarTarget: effectiveStarTarget,
      remainingQuestionsNeeded,
      remainingStarsNeeded,
      masterPrompt,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to build cheap lane A package");
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

router.post("/configs/:id/cheap/import", requireAdmin, async (req, res) => {
  try {
    const { id } = TriggerGenerationParams.parse(req.params);
    const userId = String((req as any).userId || "admin");
    const result = await performCheapImport(id, req.body, userId, req.log);
    res.json(result);
  } catch (error) {
    req.log.error({ err: error }, "Failed to import cheap lane B content");
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

router.post("/configs/:id/cheap/import/start", requireAdmin, async (req, res) => {
  try {
    const { id } = TriggerGenerationParams.parse(req.params);
    const current = getCheapImportProgress(id);
    if (current.status === "processing") {
      res.status(409).json({ error: "Cheap import is already running for this config." });
      return;
    }

    const userId = String((req as any).userId || "admin");
    setCheapImportProgress(id, {
      status: "processing",
      stage: "validating",
      processedQuestions: 0,
      totalQuestions: 0,
      message: "Preparing import...",
      warnings: [],
      error: undefined,
      saved: undefined,
    });

    void performCheapImport(id, req.body, userId, req.log)
      .then((result) => {
        setCheapImportProgress(id, {
          status: "complete",
          stage: "done",
          message: "Import complete.",
          warnings: result.warnings ?? [],
          saved: result.saved as any,
        });
      })
      .catch((error) => {
        req.log.error({ err: error, configId: id }, "Background cheap import failed");
        setCheapImportProgress(id, {
          status: "error",
          stage: "done",
          message: "Import failed.",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      });

    res.status(202).json({ success: true, configId: id, jobId: id });
  } catch (error) {
    req.log.error({ err: error }, "Failed to start cheap lane B import");
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

router.get("/configs/:id/cheap/import-status", requireAdmin, async (req, res) => {
  try {
    const { id } = TriggerGenerationParams.parse(req.params);
    res.json(getCheapImportProgress(id));
  } catch (error) {
    req.log.error({ err: error }, "Failed to get cheap import status");
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

async function performCheapImport(
  id: string,
  rawBody: unknown,
  userId: string,
  reqLog: any,
) {
  try {
    setCheapImportProgress(id, {
      status: "processing",
      stage: "validating",
      message: "Validating JSON and preparing payload...",
    });

    const pkg = await buildLaneAConfigPackage(id);
    const body = parseImportBody(rawBody);
    const warnings: string[] = [];
    const reusableExplanationMap = await loadReusableExplanationMap(pkg.subject, id);
    let reusedExplanations = 0;
    let generatedExplanations = 0;

    if (body.units.length === 0) {
      body.units = pkg.structure.map((u) => ({
        title: u.title,
        topics: u.topics.map((t) => ({
          title: t.title,
          explanation: "",
          subtopics: t.subtopics.map((s) => ({
            title: s,
            explanation: "",
          })),
        })),
      }));
      warnings.push("No valid units found in import JSON. Used lane A structure and will auto-fill explanations.");
    }

    const mandatoryMap = new Map(pkg.replicaQuestions.map((q) => [normalizeText(q.question), q]));
    const seen = new Set<string>();
    let questions = body.questions.filter((q) => {
      const key = normalizeText(q.question);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    for (const mandatory of pkg.replicaQuestions) {
      const key = normalizeText(mandatory.question);
      const has = questions.some((q) => normalizeText(q.question) === key);
      if (!has) {
        const normalizedAnswer = isInstructionalAnswerPlaceholder(mandatory.answer)
          ? buildExamReadyFallbackAnswer(
              mandatory.question,
              mandatory.markType,
              mandatory.topicTitle,
              mandatory.subtopicTitle,
            )
          : mandatory.answer;
        questions.push({
          markType: mandatory.markType,
          question: mandatory.question,
          answer: normalizedAnswer,
          unitTitle: mandatory.unitTitle,
          topicTitle: mandatory.topicTitle,
          subtopicTitle: mandatory.subtopicTitle,
          isStarred: true,
        });
      }
    }
    if (pkg.replicaQuestions.length > 0) {
      warnings.push("Mandatory replica questions were ensured during import.");
    }

    if (questions.length > pkg.totalQuestionTarget) {
      const mandatoryKeys = new Set(pkg.replicaQuestions.map((q) => normalizeText(q.question)));
      questions.sort((a, b) => {
        const aMandatory = mandatoryKeys.has(normalizeText(a.question)) ? 1 : 0;
        const bMandatory = mandatoryKeys.has(normalizeText(b.question)) ? 1 : 0;
        const aStar = a.isStarred ? 1 : 0;
        const bStar = b.isStarred ? 1 : 0;
        return bMandatory - aMandatory || bStar - aStar;
      });
      questions = questions.slice(0, pkg.totalQuestionTarget);
      warnings.push(`Question list exceeded ${pkg.totalQuestionTarget}; trimmed automatically.`);
    }

    if (questions.length < pkg.totalQuestionTarget) {
      const flatSubtopics = body.units.flatMap((u) =>
        u.topics.flatMap((t) =>
          t.subtopics.map((s) => ({ unitTitle: u.title, topicTitle: t.title, subtopicTitle: s.title }))
        )
      );
      let idx = 0;
      while (questions.length < pkg.totalQuestionTarget && flatSubtopics.length > 0) {
        const s = flatSubtopics[idx % flatSubtopics.length];
        questions.push({
          markType: idx % 2 === 0 ? "Foundational" : "Applied",
          question: idx % 2 === 0 ? `Explain ${s.subtopicTitle}.` : `Apply ${s.subtopicTitle} with a practical example.`,
          answer: idx % 2 === 0
            ? buildExamReadyFallbackAnswer(`Explain ${s.subtopicTitle}.`, "Foundational", s.topicTitle, s.subtopicTitle)
            : buildExamReadyFallbackAnswer(`Apply ${s.subtopicTitle} with a practical example.`, "Applied", s.topicTitle, s.subtopicTitle),
          unitTitle: s.unitTitle,
          topicTitle: s.topicTitle,
          subtopicTitle: s.subtopicTitle,
          isStarred: false,
        });
        idx++;
      }
      warnings.push("Question list was below target; auto-filled remaining with template questions.");
    }

    setCheapImportProgress(id, {
      stage: "saving_structure",
      totalQuestions: questions.length,
      processedQuestions: 0,
      message: "Saving units, topics, and subtopics...",
      warnings,
    });

    const starredTarget = pkg.replicaQuestions.length > 0 ? pkg.totalStarTarget : 0;
    let starredCount = questions.filter((q) => q.isStarred).length;
    if (starredCount < starredTarget) {
      for (const q of questions) {
        if (starredCount >= starredTarget) break;
        if (!q.isStarred) {
          q.isStarred = true;
          starredCount++;
        }
      }
      warnings.push(`Star count was low; auto-adjusted to ${starredTarget}.`);
    } else if (starredCount > starredTarget) {
      const mandatoryKeys = new Set(pkg.replicaQuestions.map((q) => normalizeText(q.question)));
      for (let i = questions.length - 1; i >= 0 && starredCount > starredTarget; i--) {
        const q = questions[i];
        if (q.isStarred && !mandatoryKeys.has(normalizeText(q.question))) {
          q.isStarred = false;
          starredCount--;
        }
      }
      for (let i = questions.length - 1; i >= 0 && starredCount > starredTarget; i--) {
        const q = questions[i];
        if (q.isStarred) {
          q.isStarred = false;
          starredCount--;
        }
      }
      warnings.push(`Star count exceeded target; auto-trimmed to ${starredTarget}.`);
    }

    const pathMap = new Map<string, { nodeId: string; unitSubtopicId: string }>();

    await db.transaction(async (tx) => {
      const existingNodes = await tx
        .select({ id: nodesTable.id })
        .from(nodesTable)
        .where(eq(nodesTable.configId, id));
      if (existingNodes.length > 0) {
        await tx.delete(configQuestionsTable).where(eq(configQuestionsTable.configId, id));
        await tx.delete(nodesTable).where(eq(nodesTable.configId, id));
      }

      const normalizedSubject = normalizeText(pkg.subject);
      let [subject] = await tx
        .select({ id: subjectsTable.id })
        .from(subjectsTable)
        .where(eq(subjectsTable.normalizedName, normalizedSubject))
        .limit(1);

      if (!subject) {
        const subjectId = `sub_${randomUUID().substring(0, 8)}`;
        await tx.insert(subjectsTable).values({
          id: subjectId,
          name: pkg.subject,
          normalizedName: normalizedSubject,
          createdBy: userId,
        });
        subject = { id: subjectId };
      }

      const unitLibraryIdByNormTitle = new Map<string, string>();
      for (const unit of body.units) {
        const normalizedUnitTitle = normalizeText(unit.title);
        if (!normalizedUnitTitle) continue;
        const topics = unit.topics.map((t) => ({
          title: t.title,
          subtopics: t.subtopics.map((s) => s.title),
        }));

        const [existing] = await tx
          .select({ id: unitLibraryTable.id })
          .from(unitLibraryTable)
          .where(and(
            eq(unitLibraryTable.subjectId, subject.id),
            eq(unitLibraryTable.normalizedUnitTitle, normalizedUnitTitle),
          ))
          .limit(1);

        if (existing) {
          await tx
            .update(unitLibraryTable)
            .set({
              unitTitle: unit.title,
              topics,
              sourceText: "Imported from cheap mode",
              updatedAt: new Date(),
            })
            .where(eq(unitLibraryTable.id, existing.id));
          unitLibraryIdByNormTitle.set(normalizedUnitTitle, existing.id);
        } else {
          const createdId = `unit_${randomUUID().substring(0, 8)}`;
          await tx.insert(unitLibraryTable).values({
            id: createdId,
            subjectId: subject.id,
            unitTitle: unit.title,
            normalizedUnitTitle,
            topics,
            sourceText: "Imported from cheap mode",
            createdBy: userId,
          });
          unitLibraryIdByNormTitle.set(normalizedUnitTitle, createdId);
        }
      }

      for (let ui = 0; ui < body.units.length; ui++) {
        const unit = body.units[ui];
        const unitLibraryId = unitLibraryIdByNormTitle.get(normalizeText(unit.title));
        if (!unitLibraryId) continue;
        const unitId = `${id}_u${ui + 1}`;
        await tx.insert(nodesTable).values({
          id: unitId,
          configId: id,
          title: unit.title,
          type: "unit",
          parentId: null,
          sortOrder: String(ui + 1),
        });

        for (let ti = 0; ti < unit.topics.length; ti++) {
          const topic = unit.topics[ti];
          const topicId = `${id}_u${ui + 1}_t${ti + 1}`;
          let topicExplanation = (topic.explanation || "").trim();
          if (!topicExplanation) {
            try {
              topicExplanation = await generateTopicExplanation(
                pkg.subject,
                unit.title,
                topic.title,
              );
            } catch {
              topicExplanation = "Topic summary will be updated soon.";
            }
          }

          const normalizedTopicTitle = normalizeText(topic.title);
          const topicCanonicalId = `utp_${unitLibraryId}_${toSlug(topic.title)}`;
          const topicUpsert = await tx
            .insert(unitTopicsTable)
            .values({
              id: topicCanonicalId,
              unitLibraryId,
              title: topic.title,
              normalizedTitle: normalizedTopicTitle,
              sortOrder: ti + 1,
              explanation: repairBrokenFormulaBullets(topicExplanation),
            })
            .onConflictDoUpdate({
              target: [unitTopicsTable.unitLibraryId, unitTopicsTable.normalizedTitle],
              set: {
                title: topic.title,
                sortOrder: ti + 1,
                explanation: repairBrokenFormulaBullets(topicExplanation),
                updatedAt: new Date(),
              },
            })
            .returning({ id: unitTopicsTable.id });
          const unitTopicId = topicUpsert[0]?.id || topicCanonicalId;

          await tx.insert(nodesTable).values({
            id: topicId,
            configId: id,
            title: topic.title,
            type: "topic",
            parentId: unitId,
            explanation: repairBrokenFormulaBullets(topicExplanation),
            unitTopicId,
            sortOrder: String(ti + 1),
          });

          for (let si = 0; si < topic.subtopics.length; si++) {
            const sub = topic.subtopics[si];
            const subId = `${id}_u${ui + 1}_t${ti + 1}_s${si + 1}`;
            const key = explanationKey(unit.title, topic.title, sub.title);
            let explanation = (sub.explanation || "").trim();
            if (!explanation) {
              const reused = reusableExplanationMap.get(key);
              if (reused?.trim()) {
                explanation = reused;
                reusedExplanations++;
              } else {
                try {
                  explanation = await generateSubtopicExplanation(
                    pkg.subject,
                    unit.title,
                    topic.title,
                    sub.title,
                  );
                  generatedExplanations++;
                } catch {
                  explanation = "Content will be updated soon.";
                }
              }
            }

            const normalizedSubtopicTitle = normalizeText(sub.title);
            const subCanonicalId = `ust_${unitTopicId}_${toSlug(sub.title)}`;
            const subtopicUpsert = await tx
              .insert(unitSubtopicsTable)
              .values({
                id: subCanonicalId,
                unitTopicId,
                title: sub.title,
                normalizedTitle: normalizedSubtopicTitle,
                sortOrder: si + 1,
                explanation: repairBrokenFormulaBullets(explanation),
              })
              .onConflictDoUpdate({
                target: [unitSubtopicsTable.unitTopicId, unitSubtopicsTable.normalizedTitle],
                set: {
                  title: sub.title,
                  sortOrder: si + 1,
                  explanation: repairBrokenFormulaBullets(explanation),
                  updatedAt: new Date(),
                },
              })
              .returning({ id: unitSubtopicsTable.id });
            const unitSubtopicId = subtopicUpsert[0]?.id || subCanonicalId;

            await tx.insert(nodesTable).values({
              id: subId,
              configId: id,
              title: sub.title,
              type: "subtopic",
              parentId: topicId,
              unitTopicId,
              unitSubtopicId,
              sortOrder: String(si + 1),
            });
            pathMap.set(key, { nodeId: subId, unitSubtopicId });
          }
        }
      }
    });

    setCheapImportProgress(id, {
      stage: "saving_questions",
      message: "Saving question bank...",
    });

    let processedQuestions = 0;
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const key = `${normalizeText(q.unitTitle)}|${normalizeText(q.topicTitle)}|${normalizeText(q.subtopicTitle)}`;
      const mapped = pathMap.get(key) || Array.from(pathMap.values())[0];
      if (!mapped) continue;

      await db.insert(configQuestionsTable).values({
        configId: id,
        unitSubtopicId: mapped.unitSubtopicId,
        legacyNodeId: mapped.nodeId,
        legacyQuestionId: null,
        markType: q.markType,
        question: q.question,
        answer: repairBrokenFormulaBullets(q.answer),
        isStarred: !!q.isStarred,
        starSource: q.isStarred ? "manual" : "none",
      });

      processedQuestions++;
      if (processedQuestions % 10 === 0 || processedQuestions === questions.length) {
        setCheapImportProgress(id, {
          stage: "saving_questions",
          processedQuestions,
          totalQuestions: questions.length,
          message: `Saving questions (${processedQuestions}/${questions.length})`,
          warnings,
        });
      }
    }

    setCheapImportProgress(id, {
      stage: "finalizing",
      processedQuestions: questions.length,
      totalQuestions: questions.length,
      message: "Finalizing import...",
      warnings,
    });

    return {
      success: true,
      warnings,
      saved: {
        units: body.units.length,
        questions: questions.length,
        reusedExplanations,
        generatedExplanations,
      },
    };
  } catch (error) {
    reqLog.error({ err: error }, "Failed to import cheap lane B content");
    throw error;
  }
}

router.delete("/configs/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = PublishConfigParams.parse(req.params);

    const [config] = await db
      .select({ id: configsTable.id })
      .from(configsTable)
      .where(eq(configsTable.id, id))
      .limit(1);

    if (!config) {
      res.status(404).json({ error: "Config not found" });
      return;
    }

    // Disable only: keep units/topics/subtopics + explanations + Q&A + events for reuse.
    await db
      .update(configsTable)
      .set({ status: "disabled" })
      .where(eq(configsTable.id, id));

    res.json({ success: true, disabled: true });
  } catch (error) {
    req.log.error({ err: error }, "Failed to delete config");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

