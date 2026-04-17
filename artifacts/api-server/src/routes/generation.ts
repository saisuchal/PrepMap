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
  canonicalNodesTable,
  eventsTable,
} from "../db";
import { and, eq, inArray } from "drizzle-orm";
import { createHash, randomUUID } from "crypto";
import { runGeneration, getProgress, buildLaneAConfigPackage, isLikelyQuestionText } from "../lib/generator";
import { requireAdmin } from "../middleware/adminAuth";
import { askAI } from "../lib/ai";
import { repairBrokenFormulaBullets } from "../lib/textFormatting";

const router: IRouter = Router();

type CheapGenerationMode = "explanations_only" | "explanations_and_questions" | "questions_only";

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
  overwritePolicy?: OverwritePolicy;
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

function hash8(parts: string[]): string {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 8);
}

function canonicalUnitId(subjectId: string, unitTitle: string): string {
  return `${subjectId}_u_${hash8([subjectId, normalizeText(unitTitle)])}`;
}

function canonicalTopicId(subjectId: string, unitTitle: string, topicTitle: string): string {
  return `${subjectId}_t_${hash8([subjectId, normalizeText(unitTitle), normalizeText(topicTitle)])}`;
}

function canonicalSubtopicId(subjectId: string, unitTitle: string, topicTitle: string, subtopicTitle: string): string {
  return `${subjectId}_s_${hash8([subjectId, normalizeText(unitTitle), normalizeText(topicTitle), normalizeText(subtopicTitle)])}`;
}

function scopedNodeId(configId: string, canonicalId: string): string {
  return `${configId}_${canonicalId}`;
}

function parseCheapGenerationMode(value: unknown): CheapGenerationMode {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "explanations_only") return "explanations_only";
  if (raw === "questions_only") return "questions_only";
  return "explanations_and_questions";
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

function buildStructureWithFacts(
  structure: Array<{ title: string; topics: Array<{ title: string; subtopics: string[] }> }>,
  factGrounding: Array<{
    title: string;
    topics: Array<{
      title: string;
      topicFacts: Array<{ factId: string; type: string; text: string; sourceSpan: string }>;
      subtopics: Array<{ title: string; facts: Array<{ factId: string; type: string; text: string; sourceSpan: string }> }>;
    }>;
  }>,
) {
  const factUnitMap = new Map(factGrounding.map((u) => [normalizeText(u.title), u]));
  return structure.map((unit) => {
    const factUnit = factUnitMap.get(normalizeText(unit.title));
    const factTopicMap = new Map((factUnit?.topics ?? []).map((t) => [normalizeText(t.title), t]));
    return {
      title: unit.title,
      topics: unit.topics.map((topic) => {
        const factTopic = factTopicMap.get(normalizeText(topic.title));
        const factSubMap = new Map((factTopic?.subtopics ?? []).map((s) => [normalizeText(s.title), s]));
        return {
          title: topic.title,
          topicFacts: factTopic?.topicFacts ?? [],
          subtopics: topic.subtopics.map((subtopic) => ({
            title: subtopic,
            facts: factSubMap.get(normalizeText(subtopic))?.facts ?? [],
          })),
        };
      }),
    };
  });
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

  const unitById = new Map(units.map((u) => [u.id, u]));
  const unitIds = units.map((u) => u.id);
  const canonicalRows =
    unitIds.length > 0
      ? await db
          .select({
            id: canonicalNodesTable.id,
            unitLibraryId: canonicalNodesTable.unitLibraryId,
            title: canonicalNodesTable.title,
            type: canonicalNodesTable.type,
            parentCanonicalNodeId: canonicalNodesTable.parentCanonicalNodeId,
            explanation: canonicalNodesTable.explanation,
          })
          .from(canonicalNodesTable)
          .where(inArray(canonicalNodesTable.unitLibraryId, unitIds))
      : [];

  const canonicalById = new Map(canonicalRows.map((row) => [row.id, row]));
  const reuse = new Map<string, string>();
  for (const sub of canonicalRows) {
    if (sub.type !== "subtopic") continue;
    const explanation = normalizeCoreExplanation(String(sub.explanation || ""));
    if (!explanation) continue;
    const topic = sub.parentCanonicalNodeId ? canonicalById.get(sub.parentCanonicalNodeId) : null;
    if (!topic) continue;
    const unit = topic.unitLibraryId ? unitById.get(topic.unitLibraryId) : null;
    if (!unit) continue;

    const key = explanationKey(unit.unitTitle, topic.title, sub.title);
    if (!reuse.has(key)) reuse.set(key, explanation);
  }

  return reuse;
}

type ImportUnit = {
  title: string;
  topics: Array<{
    title: string;
    explanation?: string;
    learning_goal?: string;
    example_block?: string;
    support_note?: string;
    prerequisite_titles?: string[];
    prerequisite_node_ids?: string[];
    next_recommended_titles?: string[];
    next_recommended_node_ids?: string[];
    subtopics: Array<{
      title: string;
      explanation: string;
      learning_goal?: string;
      example_block?: string;
      support_note?: string;
      prerequisite_titles?: string[];
      prerequisite_node_ids?: string[];
      next_recommended_titles?: string[];
      next_recommended_node_ids?: string[];
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

type OverwritePolicy = "preserve_existing" | "force_overwrite";

function mergeImportedText(
  existingValue: string | null | undefined,
  incomingValue: string | undefined,
  forceOverwrite: boolean,
): string | null {
  const existing = String(existingValue || "").trim();
  const incoming = String(incomingValue || "").trim();
  if (forceOverwrite) return incoming || existing || null;
  return existing || incoming || null;
}

function parseStoredStringArray(raw: string | null | undefined): string[] {
  const text = String(raw || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map((v) => String(v || "").trim()).filter(Boolean);
  } catch {
    return [];
  }
  return [];
}

function mergeImportedArray(
  existingValue: string | null | undefined,
  incomingValue: string[] | undefined,
  forceOverwrite: boolean,
): string {
  const existing = parseStoredStringArray(existingValue);
  const incoming = (incomingValue || []).map((v) => String(v || "").trim()).filter(Boolean);
  if (forceOverwrite) {
    return JSON.stringify(incoming.length > 0 ? incoming : existing);
  }
  return JSON.stringify(existing.length > 0 ? existing : incoming);
}

function parseImportBody(body: unknown): {
  mode: CheapGenerationMode;
  subject?: string;
  units: ImportUnit[];
  questions: ImportQuestion[];
} {
  const mode = parseCheapGenerationMode((body as any)?.mode ?? (body as any)?.generationMode);
  const subject = String((body as any)?.subject || "").trim() || undefined;
  const unitsRaw = Array.isArray((body as any)?.units) ? (body as any).units : [];
  const questionsRaw = Array.isArray((body as any)?.questions) ? (body as any).questions : [];

  const units: ImportUnit[] = unitsRaw
    .map((u: any) => ({
      title: String(u?.title || "").trim(),
      topics: (Array.isArray(u?.topics) ? u.topics : []).map((t: any) => ({
        title: String(t?.title || "").trim(),
        explanation: String(t?.explanation || "").trim(),
        learning_goal: String(t?.learning_goal || t?.learningGoal || "").trim(),
        example_block: String(t?.example_block || t?.exampleBlock || "").trim(),
        support_note: String(t?.support_note || t?.supportNote || "").trim(),
        prerequisite_titles: parseTextArray(t?.prerequisite_titles ?? t?.prerequisiteTitles),
        prerequisite_node_ids: parseTextArray(t?.prerequisite_node_ids ?? t?.prerequisiteNodeIds),
        next_recommended_titles: parseTextArray(t?.next_recommended_titles ?? t?.nextRecommendedTitles),
        next_recommended_node_ids: parseTextArray(t?.next_recommended_node_ids ?? t?.nextRecommendedNodeIds),
        subtopics: (Array.isArray(t?.subtopics) ? t.subtopics : []).map((s: any) => ({
          title: String(s?.title || "").trim(),
          explanation: String(s?.explanation || "").trim(),
          learning_goal: String(s?.learning_goal || s?.learningGoal || "").trim(),
          example_block: String(s?.example_block || s?.exampleBlock || "").trim(),
          support_note: String(s?.support_note || s?.supportNote || "").trim(),
          prerequisite_titles: parseTextArray(s?.prerequisite_titles ?? s?.prerequisiteTitles),
          prerequisite_node_ids: parseTextArray(s?.prerequisite_node_ids ?? s?.prerequisiteNodeIds),
          next_recommended_titles: parseTextArray(s?.next_recommended_titles ?? s?.nextRecommendedTitles),
          next_recommended_node_ids: parseTextArray(s?.next_recommended_node_ids ?? s?.nextRecommendedNodeIds),
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

  return { mode, subject, units, questions };
}

function parseTextArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v || "").trim()).filter(Boolean);
  }
  const text = String(raw ?? "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((v) => String(v || "").trim()).filter(Boolean);
    }
  } catch {
    // fall through
  }
  if (text.includes(",")) {
    return text.split(",").map((v) => v.trim()).filter(Boolean);
  }
  return [text];
}

function toStoredArrayValue(values: string[] | undefined): string | null {
  const clean = (values || []).map((v) => String(v || "").trim()).filter(Boolean);
  // Return an empty JSON array string instead of null to satisfy NOT NULL DB columns
  return JSON.stringify(clean);
}

function normalizeCoreExplanation(rawText: string): string {
  const text = String(rawText || "").trim();
  if (!text) return "";
  const cleanedLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      line.length > 0 &&
      !/^\s*(learning goal|quick example|helper note|helpful note|support note)\s*:/i.test(line),
    )
    .map((line) => line.replace(/^\s*core idea\s*:\s*/i, "").trim())
    .filter(Boolean);
  return repairBrokenFormulaBullets(cleanedLines.join("\n\n").trim() || text);
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
    const forceCreateNew = Boolean((req.body as any)?.forceCreateNew);
    const reuseDisabledConfigId = String((req.body as any)?.reuseDisabledConfigId || "").trim();

    const existing = await db
      .select()
      .from(configsTable)
      .where(and(
        eq(configsTable.universityId, body.universityId),
        eq(configsTable.year, body.year),
        eq(configsTable.branch, body.branch),
        eq(configsTable.subject, body.subject),
        eq(configsTable.exam, body.exam),
      ));

    const activeExisting = existing.filter((cfg) => cfg.status !== "deleted");
    const activeMatch = activeExisting.find((cfg) => cfg.status !== "disabled");
    if (activeMatch) {
      res.status(409).json({
        error: "A config for this subject, semester, branch, and exam already exists.",
      });
      return;
    }

    const disabledMatches = activeExisting.filter((cfg) => cfg.status === "disabled");
    if (disabledMatches.length > 0) {
      if (reuseDisabledConfigId) {
        const target = disabledMatches.find((cfg) => cfg.id === reuseDisabledConfigId);
        if (!target) {
          res.status(400).json({
            error: "Invalid reuseDisabledConfigId for this config combination.",
          });
          return;
        }

        await db
          .update(configsTable)
          .set({ status: "draft", updatedAt: new Date() })
          .where(eq(configsTable.id, target.id));

        const [revived] = await db
          .select()
          .from(configsTable)
          .where(eq(configsTable.id, target.id))
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

      if (!forceCreateNew) {
        res.status(409).json({
          error: "Matching disabled configs found.",
          disabledMatches: disabledMatches.map((cfg) => ({
            id: cfg.id,
            createdAt: cfg.createdAt?.toISOString() ?? null,
            status: cfg.status,
          })),
        });
        return;
      }
    }

    if (activeExisting.length > 0 && !forceCreateNew && !reuseDisabledConfigId) {
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
        updatedAt: new Date(),
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
      .set({ status: newStatus, updatedAt: new Date() })
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
    const mode = parseCheapGenerationMode((req.body as any)?.mode);

    const isQuestionsOnly = mode === "questions_only";
    const isExplanationsOnly = mode === "explanations_only";

    const effectiveStarTarget =
      isExplanationsOnly ? 0 : pkg.replicaQuestions.length > 0 ? pkg.totalStarTarget : 0;
    const starredReplica = pkg.replicaQuestions.filter((q) => q.isStarred).length;
    const totalQuestionTarget = isExplanationsOnly ? 0 : pkg.totalQuestionTarget;
    const remainingStarsNeeded = Math.max(0, effectiveStarTarget - starredReplica);
    const remainingQuestionsNeeded = Math.max(
      0,
      totalQuestionTarget - pkg.replicaQuestions.length,
    );
    const structureWithFacts = buildStructureWithFacts(pkg.structure, pkg.factGrounding);

    const masterPrompt = `You are an exam prep content generator. Your only job is to write a single valid JSON object directly into a downloadable file artifact named "exam_prep_output.json".

    OUTPUT RULES (strict):
    - Create a file artifact named "exam_prep_output.json" and write the JSON directly into it.
    - Do not write any scripts, code, or programs to generate the JSON — write the JSON itself.
    - Do not use any file writers, code executors, or intermediate tools.
    - The artifact must contain exactly one valid JSON object, pretty-printed with 2-space indentation.
    - The artifact must start with { and end with }. No text before or after inside the artifact.
    - Do not wrap the JSON in markdown fences or code blocks inside the artifact.
    - Do not write any preamble, explanation, or commentary before opening the artifact.
    - After the artifact is complete, write exactly one line: "Done. Download exam_prep_output.json above."
    - If the output is too large to fit in one artifact, say "SPLIT NEEDED" and wait for instructions before proceeding.

    STRICT OUTPUT: The artifact must contain ONLY valid pretty-printed JSON in this exact shape:
    {
      "units": [
        {
          "title": "Unit title",
          "topics": [
            {
              "title": "Topic title",
              "explanation": "Clear and direct topic explanation in 2 short paragraphs (what+why, then how). Concept only — no examples here.",
              "example_block": "Example only. Either: (A) explanatory prose with inline backtick code pieces e.g. \`AVG(score)\` computes the mean of non-null values, OR (B) one short label line + triple-backtick fenced code block (3-10 lines) + one follow-up explanation line. Use Format B when code benefits from visual separation. Serialize newlines as \\n inside the JSON string.",
              "support_note": "One short helpful note, pitfall, exception, or reminder in 1-2 lines. Prose only — if a code piece is needed wrap it in backticks. Serialize any newlines as \\n.",
              "learning_goal": "One short line saying what the learner should be able to do after this topic",
              "prerequisite_titles": ["At most one earlier topic title from the same unit"],
              "next_recommended_titles": ["At most one later topic title from the same unit"],
              "subtopics": [
                {
                  "title": "Subtopic title",
                  "explanation": "Clear and direct subtopic explanation in 2 short paragraphs. Concept only — no examples here.",
                  "example_block": "Example only. Either: (A) explanatory prose with inline backtick code pieces e.g. \`AVG(score)\` computes the mean of non-null values, OR (B) one short label line + triple-backtick fenced code block (3-10 lines) + one follow-up explanation line. Use Format B when code benefits from visual separation. Serialize newlines as \\n inside the JSON string.",
                  "support_note": "One short helpful note, pitfall, exception, or reminder in 1-2 lines. Prose only — if a code piece is needed wrap it in backticks. Serialize any newlines as \\n.",
                  "learning_goal": "One short line saying what the learner should be able to do after this subtopic",
                  "prerequisite_titles": ["At most one earlier subtopic title from the same topic"],
                  "next_recommended_titles": ["At most one later subtopic title from the same topic"]
                }
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
    - Mode selected: ${mode}
    - Subject context (strict): ${pkg.subject}
    - All explanations, examples, terminology, and code snippets must stay aligned to this subject context.
    - Do not switch to examples from a different language/domain (e.g., for C++ context, do not use Python syntax).
    - If subject context is non-technical, avoid code blocks and keep examples practical and textual.
    - If subject context is technical, use conventions and syntax appropriate to this subject context only.
    - explanations_only: populate units fully, set "questions": [].
    - questions_only: write unit/topic/subtopic titles plus all required fields (explanation, example_block, support_note, learning_goal, prerequisite_titles, next_recommended_titles) as short single-sentence placeholders — do not skip any field. Populate questions fully.
    - explanations_and_questions: populate both units and questions fully.
    - Include all mandatory replica questions exactly as given below (skip this only for explanations_only mode).
    - Total questions required: ${totalQuestionTarget}
    - Total starred required: ${effectiveStarTarget}
    - Replica questions already included: ${pkg.replicaQuestions.length}
    - Remaining questions to generate: ${remainingQuestionsNeeded}
    - Remaining starred to allocate across non-replica questions: ${remainingStarsNeeded}
    - Distribute starred questions evenly — no more than 2 consecutive non-starred questions before a starred one.
    - Answers must be concise and cleanly formatted.
    - Answers must be actual exam-ready answers, not answer-writing instructions.
    - Never use placeholder text like "Use a short exam answer..." or "Use a structured exam answer...".
    - No duplicates.
    - Include only real exam questions (no metadata lines like Bloom levels K1/K2, Course Outcomes, Part/Section headers, Q.No tables, or instructions like "Answer any...").
    - Return exactly one JSON object inside the artifact and nothing else.
    - Do not wrap output in markdown/code fences inside the artifact.
    - Ensure JSON is syntactically valid:
      - Escape inner double quotes inside string values (use \\").
      - No trailing commas.
      - Use true/false for booleans (not strings).
      - Serialize all newlines inside string values as \\n — this applies to every field including answer, example_block, and support_note. Never use raw line breaks inside a JSON string.
    - Pretty-print the entire JSON with 2-space indentation.
    - questions array must contain exactly ${totalQuestionTarget} items.
    - Exactly ${effectiveStarTarget} items must have "isStarred": true.
    - unitTitle/topicTitle/subtopicTitle in each question must exactly match titles from STRUCTURE.
    - markType must be only "Foundational" or "Applied".
    - Map marks to labels as: 1-3 marks => Foundational, 4+ marks => Applied.
    - Keep mandatory replica questions verbatim for question text.
    - Topic/subtopic explanations must be beginner-friendly and written in simple English.
    - Each topic/subtopic explanation must be concept-only — no examples inside explanation fields.
    - All examples belong exclusively in "example_block". Never put an example in "explanation".
    - "example_block" format rules (pick one per field):
        Format A: Explanatory prose sentence(s) with inline backtick code pieces for short snippets.
                  e.g. Use \`COUNT(*)\` to count all rows including nulls.
        Format B: One short label line + triple-backtick fenced code block (3-10 lines max) + one follow-up explanation line.
                  Serialize as a single JSON string — use \\n for line breaks, keep backticks literal.
                  e.g. "Count all rows:\\n\`\`\`sql\\nSELECT COUNT(*) FROM player_match_details;\\n\`\`\`\\nThis returns the total row count even when score is NULL."
        Use Format B when the code snippet benefits from visual separation. Use Format A for short inline cases.
    - "support_note" format rules:
        - Prose only — no standalone code blocks.
        - Wrap any code piece in backticks for inline rendering e.g. \`COUNT(*)\`.
        - Serialize any newlines as \\n.
    - Add "example_block", "support_note", and "learning_goal" for every topic and subtopic regardless of mode.
    - Add prerequisite_titles and next_recommended_titles for every topic/subtopic regardless of mode (at most one title each, or []).
    - Use facts included inside STRUCTURE (topicFacts and subtopics[].facts) to keep explanations and answers faithful to source material in all modes.
    - Explanations must use 2 short paragraphs (not one dense block). No examples in explanation.
    - Tone requirement (strict): beginner-friendly simple English only.
    - Foundational answers: target 80-100 words (acceptable range 75-110), easy to revise. (Applies only when mode includes questions.)
    - Applied answers: target 150-200 words (acceptable range 140-220), with clearer depth than foundational. (Applies only when mode includes questions.)
    - Foundational answer format: (Applies only when mode includes questions.)
      - 2 short paragraphs OR 3-5 flat bullets.
      - Keep one tiny example in the final line/paragraph.
    - Applied answer format: (Applies only when mode includes questions.)
      - 3 clear parts: concept, mechanism/steps, mini application example.
      - Use short paragraphs or 4-7 flat bullets (no nested bullets).
    - QUALITY BAR (strict): (Applies only when mode includes questions.)
      - Do not produce word-dump answers.
      - Do not produce one-line answers unless the question is definition-only and still exam-ready.
      - Every answer must be scan-friendly with short paragraphs or flat bullets.
      - Never use meta-writing phrases like "In exam, write..." or "You can mention...".
    - Answer flow (mandatory, applies only when mode includes questions):
      1) direct concept statement,
      2) short working/mechanism explanation,
      3) tiny practical example.
    - Code examples in answers (applies only when mode includes questions):
      - If the subject/question is technical, include a short fenced code block (3-10 lines) in most answers, especially Applied answers.
      - Use realistic code-like snippets, not pseudo placeholders.
      - Wrap inline code pieces (API names, function calls, short snippets) in backticks.
      - For standalone code blocks, use triple-backtick fenced blocks with a language tag. Serialize as \\n inside the JSON string — same rule as example_block.
      - Place one short explanation line before or after the code block to connect it to the answer.
      - If the subject/question is non-technical, avoid code blocks and use short step-wise explanation with a tiny practical example.
    - Explanation writing quality:
      - Topic explanations: 2 short paragraphs (what+why, then how). No examples. Simple words.
      - Subtopic explanations: 2 short paragraphs. No examples. Simple words.
      - "example_block" is the only place for examples — keep it faithful to the concept explained above it.
      - Use Format A (inline backtick prose) for simple cases. Use Format B (fenced block + label + follow-up) when code needs visual separation.
      - Always serialize every field as a valid JSON string: escape all newlines as \\n, never use raw line breaks anywhere.

    FINAL VALIDATION (must pass all before closing the artifact):
    1) JSON parses without error.
    2) units preserve the same hierarchy from STRUCTURE.
    3) questions.length === ${totalQuestionTarget}
    4) count(isStarred=true) === ${effectiveStarTarget}
    5) all mandatory replica questions are present and verbatim.
    6) no duplicate question text after normalization.
    Fix any failure before closing the artifact. Do not write commentary during validation — output only the minimal corrective patch to the artifact if needed, then close the artifact and write the confirmation line.

    GENERATION PROCEDURE (follow in order):
    - Do NOT plan, outline, draft, or write any script before writing. Open the artifact and start writing JSON immediately.
    - The very first character written into the artifact must be {. No text, no explanation, no code before it.
    - Write the JSON directly into the artifact, pretty-printed with 2-space indentation — never delegate to a script or tool.
    Step A) Open the artifact named "exam_prep_output.json" and begin streaming "units" — copy STRUCTURE titles and write all explanation/example_block/support_note/learning_goal/prerequisite_titles/next_recommended_titles fields inline as you go.
    Step B) explanations_only: write full unit content, then write "questions": [] and close the JSON with }.
    Step C) questions_only: write all unit fields as short single-sentence placeholders (no field may be omitted), then stream all questions into the artifact.
    Step D) explanations_and_questions: write full units, then stream all questions into the artifact.
    Step E) In questions array: insert all MANDATORY_REPLICA_QUESTIONS first, then generate remaining questions.
    Step F) Assign isStarred flags as you write each question — do not defer starring to a second pass.
    Step G) Close the JSON with } and close the artifact.
    Step H) Run FINAL VALIDATION without commentary:
             - Check JSON validity, question count, starred count, replica presence, no duplicates.
             - If any check fails, reopen the artifact and apply only the minimal corrective patch (targeted field edits only — do not rewrite the entire JSON).
             - Close the artifact and write exactly one line: "Done. Download exam_prep_output.json above."

    STRUCTURE:
    ${JSON.stringify(structureWithFacts, null, 2)}

    MANDATORY_REPLICA_QUESTIONS:
    ${JSON.stringify(pkg.replicaQuestions, null, 2)}
    `;


// const masterPrompt = `You are an exam prep content generator. Your only job is to produce a single valid JSON object and save it as a downloadable artifact file named "exam_prep_output.json".

//     OUTPUT RULES (strict):
//     - Create a downloadable artifact file named "exam_prep_output.json".
//     - The artifact must contain exactly one valid JSON object and nothing else.
//     - Do not add markdown fences, preamble, explanation, or commentary outside the artifact.
//     - After creating the artifact, write exactly one line: "Done. Download exam_prep_output.json above."
//     - If the output is too large to fit in one artifact, say "SPLIT NEEDED" and wait for instructions before proceeding.

//     STRICT OUTPUT: Return ONLY valid JSON in this exact shape:
//     {
//       "units": [
//         {
//           "title": "Unit title",
//           "topics": [
//             {
//               "title": "Topic title",
//               "explanation": "50-90 word crisp topic explanation with one tiny example/use-case",
//               "example_block": "One tiny practical example or use-case in 1-3 short lines",
//               "support_note": "One short helpful note, pitfall, exception, or reminder in 1-2 lines",
//               "learning_goal": "One short line saying what the learner should be able to do after this topic",
//               "prerequisite_titles": ["At most one earlier topic title from the same unit"],
//               "next_recommended_titles": ["At most one later topic title from the same unit"],
//               "subtopics": [
//                 {
//                   "title": "Subtopic title",
//                   "explanation": "60-100 word crisp explanation with one tiny example/use-case",
//                   "example_block": "One tiny practical example or use-case in 1-3 short lines",
//                   "support_note": "One short helpful note, pitfall, exception, or reminder in 1-2 lines",
//                   "learning_goal": "One short line saying what the learner should be able to do after this subtopic",
//                   "prerequisite_titles": ["At most one earlier subtopic title from the same topic"],
//                   "next_recommended_titles": ["At most one later subtopic title from the same topic"]
//                 }
//               ]
//             }
//           ]
//         }
//       ],
//       "questions": [
//         {
//           "markType": "Foundational" | "Applied",
//           "question": "Question text",
//           "answer": "Concise exam-ready answer",
//           "unitTitle": "Unit title",
//           "topicTitle": "Topic title",
//           "subtopicTitle": "Subtopic title",
//           "isStarred": true | false
//         }
//       ]
//     }

//     CONSTRAINTS:
//     - Keep the same unit/topic/subtopic structure.
//     - Mode selected: ${mode}
//     - explanations_only: populate units fully, set "questions": [].
//     - questions_only: keep unit/topic/subtopic titles only (minimal placeholder explanations), populate questions fully.
//     - explanations_and_questions: populate both fully.
//     - Include all mandatory replica questions exactly as given below (skip this only for explanations_only mode).
//     - Total questions required: ${totalQuestionTarget}
//     - Total starred required: ${effectiveStarTarget}
//     - Replica questions already included: ${pkg.replicaQuestions.length}
//     - Remaining questions to generate: ${remainingQuestionsNeeded}
//     - Remaining starred to allocate across non-replica questions: ${remainingStarsNeeded}
//     - Distribute starred questions evenly — no more than 2 consecutive non-starred questions before a starred one.
//     - Answers must be concise and cleanly formatted.
//     - Answers must be actual exam-ready answers, not answer-writing instructions.
//     - Never use placeholder text like "Use a short exam answer..." or "Use a structured exam answer...".
//     - No duplicates.
//     - Include only real exam questions (no metadata lines like Bloom levels K1/K2, Course Outcomes, Part/Section headers, Q.No tables, or instructions like "Answer any...").
//     - Return exactly one JSON object and nothing else.
//     - Do not wrap output in markdown/code fences.
//     - Ensure JSON is syntactically valid:
//       - Escape inner double quotes inside string values (use \\").
//       - No trailing commas.
//       - Use true/false for booleans (not strings).
//     - questions array must contain exactly ${totalQuestionTarget} items.
//     - Exactly ${effectiveStarTarget} items must have "isStarred": true.
//     - unitTitle/topicTitle/subtopicTitle in each question must exactly match titles from STRUCTURE.
//     - markType must be only "Foundational" or "Applied".
//     - Map marks to labels as: 1-3 marks => Foundational, 4+ marks => Applied.
//     - Keep mandatory replica questions verbatim for question text.
//     - Topic/subtopic explanations must be snappy and beginner-friendly.
//     - Each topic/subtopic explanation must include one tiny concrete example/use-case.
//     - Add "example_block", "support_note", and "learning_goal" for every topic and subtopic.
//     - Add prerequisite_titles and next_recommended_titles for every topic/subtopic (at most one title each, or []).
//     - Use facts included inside STRUCTURE (topicFacts and subtopics[].facts) to keep explanations and answers faithful to source material in all modes.
//     - Explanations must use short paragraphs (not one dense block).
//     - Tone requirement (strict): beginner-friendly simple English only.
//     - Foundational answers: target 80-100 words (acceptable range 75-110), easy to revise.
//     - Applied answers: target 150-200 words (acceptable range 140-220), with clearer depth than foundational.
//     - Foundational answer format:
//       - 2 short paragraphs OR 3-5 flat bullets.
//       - Keep one tiny example in the final line/paragraph.
//     - Applied answer format:
//       - 3 clear parts: concept, mechanism/steps, mini application example.
//       - Use short paragraphs or 4-7 flat bullets (no nested bullets).
//     - QUALITY BAR (strict):
//       - Do not produce word-dump answers.
//       - Do not produce one-line answers unless the question is definition-only and still exam-ready.
//       - Every answer must be scan-friendly with short paragraphs or flat bullets.
//       - Never use meta-writing phrases like "In exam, write..." or "You can mention...".
//     - Give each answer this flow (mandatory):
//       1) direct concept statement,
//       2) short working/mechanism explanation,
//       3) tiny practical example.
//     - Decide contextually for code examples:
//       - If the subject/question is technical, include a short fenced code block (3-10 lines) in most answers, especially Applied answers.
//       - Use realistic code-like snippets, not pseudo placeholders.
//       - Wrap inline code pieces (API names, function calls, short snippets) in backticks so they render as \`inline code\` (e.g., \`myFunc()\`).
//       - For standalone code examples, use triple-backtick fenced blocks with an optional language tag (for example: \`\`\`javascript\nconsole.log('hi')\n\`\`\`).
//       - Place one short explanation line before or after the code block to connect it to the answer.
//       - If the subject/question is non-technical, avoid code blocks and use short step-wise explanation with a tiny practical example.
//     - Explanation writing quality:
//       - Topic explanations: 2 short paragraphs preferred (what+why, then how) with simple words.
//       - Subtopic explanations: 2 short paragraphs preferred with one tiny concrete use-case.
//       - Keep "example_block" quick and faithful to the same concept; wrap inline code in backticks and use triple-backtick fenced code blocks for standalone examples (use an appropriate language tag when useful).

//     FINAL VALIDATION (must pass all before writing artifact):
//     1) JSON parses without error.
//     2) units preserve the same hierarchy from STRUCTURE.
//     3) questions.length === ${totalQuestionTarget}
//     4) count(isStarred=true) === ${effectiveStarTarget}
//     5) all mandatory replica questions are present and verbatim.
//     6) no duplicate question text after normalization.
//     Fix any failure before outputting.

//     GENERATION PROCEDURE (follow in order):
//     Step A) Copy STRUCTURE into "units" exactly.
//     Step B) If mode is "explanations_only": add explanations and keep "questions": [].
//     Step C) If mode is "questions_only": keep unit/topic/subtopic titles unchanged and generate only questions. Do not rewrite explanations beyond minimal placeholders.
//     Step D) If mode is "explanations_and_questions": add high-quality explanations and questions.
//     Step E) For question modes, start "questions" by inserting all MANDATORY_REPLICA_QUESTIONS first.
//     Step F) Add exactly ${remainingQuestionsNeeded} new questions so total becomes ${totalQuestionTarget}.
//     Step G) Assign starred flags — total starred must equal exactly ${effectiveStarTarget}. Distribute evenly: no more than 2 consecutive non-starred questions before a starred one.
//     Step H) Run FINAL VALIDATION. Fix any failure before writing the artifact.

//     STRUCTURE:
//     ${JSON.stringify(structureWithFacts, null, 2)}

//     MANDATORY_REPLICA_QUESTIONS:
//     ${JSON.stringify(pkg.replicaQuestions, null, 2)}
//     `;

    //     const masterPrompt = `NON-NEGOTIABLE INSTRUCTIONS:
    // - Preferred output: create exactly one downloadable JSON file named "exam_prep_output.json" containing the final JSON object.
    // - Do not build an app.
    // - Do not create app, project, or code files.
    // - Do not write code.
    // - Do not use tools.
    // - Do not explain your process.
    // - Do not add markdown fences.
    // - Do not add any text before or after the JSON object.
    // - If you cannot comply perfectly, still return the closest possible valid JSON object only.

    // You are generating exam-prep content for this config.

    // STRICT OUTPUT: Return ONLY valid JSON in this exact shape:
    // {
    //   "units": [
    //     {
    //       "title": "Unit title",
    //       "topics": [
    //         {
    //           "title": "Topic title",
    //           "explanation": "50-90 word crisp topic explanation with one tiny example/use-case",
    //           "example_block": "One tiny practical example or use-case in 1-3 short lines",
    //           "support_note": "One short helpful note, pitfall, exception, or reminder in 1-2 lines",
    //           "learning_goal": "One short line saying what the learner should be able to do after this topic",
    //           "prerequisite_titles": ["At most one earlier topic title from the same unit"],
    //           "next_recommended_titles": ["At most one later topic title from the same unit"],
    //           "subtopics": [
    //             {
    //               "title": "Subtopic title",
    //               "explanation": "60-100 word crisp explanation with one tiny example/use-case",
    //               "example_block": "One tiny practical example or use-case in 1-3 short lines",
    //               "support_note": "One short helpful note, pitfall, exception, or reminder in 1-2 lines",
    //               "learning_goal": "One short line saying what the learner should be able to do after this subtopic",
    //               "prerequisite_titles": ["At most one earlier subtopic title from the same topic"],
    //               "next_recommended_titles": ["At most one later subtopic title from the same topic"]
    //             }
    //           ]
    //         }
    //       ]
    //     }
    //   ],
    //   "questions": [
    //     {
    //       "markType": "Foundational" | "Applied",
    //       "question": "Question text",
    //       "answer": "Concise exam-ready answer",
    //       "unitTitle": "Unit title",
    //       "topicTitle": "Topic title",
    //       "subtopicTitle": "Subtopic title",
    //       "isStarred": true | false
    //     }
    //   ]
    // }

    // CONSTRAINTS:
    // - Keep the same unit/topic/subtopic structure.
    // - Mode selected: ${mode}
    // - Include all mandatory replica questions exactly as given below (skip this only for explanations_only mode).
    // - Total questions required: ${totalQuestionTarget}
    // - Total starred required: ${effectiveStarTarget}
    // - Replica questions already included: ${pkg.replicaQuestions.length}
    // - Remaining questions to generate: ${remainingQuestionsNeeded}
    // - Remaining starred to allocate across non-replica questions: ${remainingStarsNeeded}
    // - Answers must be concise and cleanly formatted.
    // - Answers must be actual exam-ready answers, not answer-writing instructions.
    // - Never use placeholder text like "Use a short exam answer..." or "Use a structured exam answer...".
    // - No duplicates.
    // - Include only real exam questions (no metadata lines like Bloom levels K1/K2, Course Outcomes, Part/Section headers, Q.No tables, or instructions like "Answer any...").
    // - Return exactly one JSON object and nothing else.
    // - Do not wrap output in markdown/code fences.
    // - Ensure JSON is syntactically valid:
    //   - Escape inner double quotes inside string values (use \\").
    //   - No trailing commas.
    //   - Use true/false for booleans (not strings).
    // - questions array must contain exactly ${totalQuestionTarget} items.
    // - Exactly ${effectiveStarTarget} items must have "isStarred": true.
    // - unitTitle/topicTitle/subtopicTitle in each question must exactly match titles from STRUCTURE.
    // - markType must be only "Foundational" or "Applied".
    // - Keep mandatory replica questions verbatim for question text.
    // - Topic/subtopic explanations must be snappy and beginner-friendly.
    // - Each topic/subtopic explanation must include one tiny concrete example/use-case.
    // - Add "example_block", "support_note", and "learning_goal" for every topic and subtopic.
    // - Add prerequisite_titles and next_recommended_titles for every topic/subtopic (at most one title each, or []).
    // - Use facts included inside STRUCTURE (topicFacts and subtopics[].facts) to keep explanations and answers faithful to source material in all modes.
    // - Explanations must use short paragraphs (not one dense block).
    // - Tone requirement (strict): beginner-friendly simple English only.
    // - Foundational answers: target 80-100 words (acceptable range 75-110), easy to revise.
    // - Applied answers: target 150-200 words (acceptable range 140-220), with clearer depth than foundational.
    // - Foundational answer format:
    //   - 2 short paragraphs OR 3-5 flat bullets.
    //   - Keep one tiny example in the final line/paragraph.
    // - Applied answer format:
    //   - 3 clear parts: concept, mechanism/steps, mini application example.
    //   - Use short paragraphs or 4-7 flat bullets (no nested bullets).
    // - QUALITY BAR (strict):
    //   - Do not produce word-dump answers.
    //   - Do not produce one-line answers unless the question is definition-only and still exam-ready.
    //   - Every answer must be scan-friendly with short paragraphs or flat bullets.
    //   - Never use meta-writing phrases like "In exam, write..." or "You can mention...".
    // - Give each answer this flow (mandatory):
    //   1) direct concept statement,
    //   2) short working/mechanism explanation,
    //   3) tiny practical example.
    // - Decide contextually for code examples:
    //   - If the subject/question is technical, include a short fenced code block (3-10 lines) in most answers, especially Applied answers.
    //   - Use realistic code-like snippets, not pseudo placeholders.
    //   - Place one short explanation line before or after the code block to connect it to the answer.
    //   - If the subject/question is non-technical, avoid code blocks and use short step-wise explanation with a tiny practical example.
    // - Explanation writing quality:
    //   - Topic explanations: 2 short paragraphs preferred (what+why, then how) with simple words.
    //   - Subtopic explanations: 2 short paragraphs preferred with one tiny concrete use-case.
    //   - Keep "example_block" quick and faithful to the same concept; use backticks for API names/syntax/formulas.
    // - If original marks are known from replica/sections, map marks to labels as:
    //   1-3 marks => Foundational, 4+ marks => Applied.

    // FINAL SELF-CHECK BEFORE OUTPUT (must pass all):
    // 1) JSON parses without error.
    // 2) units preserve the same hierarchy from STRUCTURE.
    // 3) questions.length === ${totalQuestionTarget}
    // 4) count(isStarred=true) === ${effectiveStarTarget}
    // 5) all mandatory replica questions are present.
    // 6) no duplicate question text after normalization.
    // If any check fails, fix it before returning final JSON.

    // GENERATION PROCEDURE (follow in order):
    // Step A) Copy STRUCTURE into "units" exactly.
    // Step B) If mode is "explanations_only": add explanations and keep "questions": [].
    // Step C) If mode is "questions_only": keep unit/topic/subtopic titles unchanged and generate only questions. Do not rewrite explanations beyond minimal placeholders.
    // Step D) If mode is "explanations_and_questions": add high-quality explanations and questions.
    // Step E) For question modes, start "questions" by inserting all MANDATORY_REPLICA_QUESTIONS first.
    // Step F) Add exactly ${remainingQuestionsNeeded} new questions so total becomes ${totalQuestionTarget}.
    // Step G) Keep total starred at exactly ${effectiveStarTarget}. Mandatory replicas are already starred.
    // Step H) Re-check JSON validity and all counts before final answer.

    // HARD FAILURE RULES:
    // - If mode is explanations_only, "questions" must be [].
    // - If mode is question mode, never return fewer or more than ${totalQuestionTarget} questions.
    // - If mode is question mode, never omit mandatory replica questions.
    // - Never change question text of mandatory replica questions.

    // STRUCTURE:
    // ${JSON.stringify(structureWithFacts, null, 2)}

    // MANDATORY_REPLICA_QUESTIONS:
    // ${JSON.stringify(pkg.replicaQuestions, null, 2)}
    // `;

//     const masterPrompt = `NON-NEGOTIABLE INSTRUCTIONS:
// - Preferred output: create exactly one downloadable JSON file named "exam_prep_output.json" containing the final JSON object.
// - Do not build an app.
// - Do not create app, project, or code files.
// - Do not write code.
// - Do not use tools.
// - Do not explain your process.
// - Do not add markdown fences.
// - Do not add any text before or after the JSON object.
// - If you cannot comply perfectly, still return the closest possible valid JSON object only.

// You are generating exam-prep content for this config.

// STRICT OUTPUT: Return ONLY valid JSON in this exact shape:
// {
//   "units": [
//     {
//       "title": "Unit title",
//       "topics": [
//         {
//           "title": "Topic title",
//           "explanation": "50-90 word crisp topic explanation with one tiny example/use-case",
//           "example_block": "One tiny practical example or use-case in 1-3 short lines",
//           "support_note": "One short helpful note, pitfall, exception, or reminder in 1-2 lines",
//           "learning_goal": "One short line saying what the learner should be able to do after this topic",
//           "prerequisite_titles": ["At most one earlier topic title from the same unit"],
//           "next_recommended_titles": ["At most one later topic title from the same unit"],
//           "subtopics": [
//             {
//               "title": "Subtopic title",
//               "explanation": "60-100 word crisp explanation with one tiny example/use-case",
//               "example_block": "One tiny practical example or use-case in 1-3 short lines",
//               "support_note": "One short helpful note, pitfall, exception, or reminder in 1-2 lines",
//               "learning_goal": "One short line saying what the learner should be able to do after this subtopic",
//               "prerequisite_titles": ["At most one earlier subtopic title from the same topic"],
//               "next_recommended_titles": ["At most one later subtopic title from the same topic"]
//             }
//           ]
//         }
//       ]
//     }
//   ],
//   "questions": [
//     {
//       "markType": "Foundational" | "Applied",
//       "question": "Question text",
//       "answer": "Concise exam-ready answer",
//       "unitTitle": "Unit title",
//       "topicTitle": "Topic title",
//       "subtopicTitle": "Subtopic title",
//       "isStarred": true | false
//     }
//   ]
// }

// CONSTRAINTS:
// - Keep the same unit/topic/subtopic structure.
// - Mode selected: ${mode}
// - Include all mandatory replica questions exactly as given below (skip this only for explanations_only mode).
// - Total questions required: ${totalQuestionTarget}
// - Total starred required: ${effectiveStarTarget}
// - Replica questions already included: ${pkg.replicaQuestions.length}
// - Remaining questions to generate: ${remainingQuestionsNeeded}
// - Remaining starred to allocate across non-replica questions: ${remainingStarsNeeded}
// - Answers must be concise and cleanly formatted.
// - Answers must be actual exam-ready answers, not answer-writing instructions.
// - Never use placeholder text like "Use a short exam answer..." or "Use a structured exam answer...".
// - No duplicates.
// - Include only real exam questions (no metadata lines like Bloom levels K1/K2, Course Outcomes, Part/Section headers, Q.No tables, or instructions like "Answer any...").
// - Return exactly one JSON object and nothing else.
// - Do not wrap output in markdown/code fences.
// - Ensure JSON is syntactically valid:
//   - Escape inner double quotes inside string values (use \\").
//   - No trailing commas.
//   - Use true/false for booleans (not strings).
// - questions array must contain exactly ${totalQuestionTarget} items.
// - Exactly ${effectiveStarTarget} items must have "isStarred": true.
// - unitTitle/topicTitle/subtopicTitle in each question must exactly match titles from STRUCTURE.
// - markType must be only "Foundational" or "Applied".
// - Keep mandatory replica questions verbatim for question text.
// - Topic/subtopic explanations must be snappy and beginner-friendly.
// - Each topic/subtopic explanation must include one tiny concrete example/use-case.
// - Add "example_block", "support_note", and "learning_goal" for every topic and subtopic.
// - Add prerequisite_titles and next_recommended_titles for every topic/subtopic (at most one title each, or []).
// - Use facts included inside STRUCTURE (topicFacts and subtopics[].facts) to keep explanations and answers faithful to source material in all modes.
// - Explanations must use short paragraphs (not one dense block).
// - Tone requirement (strict): beginner-friendly simple English only.
// - Foundational answers: target 80-100 words (acceptable range 75-110), easy to revise.
// - Applied answers: target 150-200 words (acceptable range 140-220), with clearer depth than foundational.
// - Foundational answer format:
//   - 2 short paragraphs OR 3-5 flat bullets.
//   - Keep one tiny example in the final line/paragraph.
// - Applied answer format:
//   - 3 clear parts: concept, mechanism/steps, mini application example.
//   - Use short paragraphs or 4-7 flat bullets (no nested bullets).
// - QUALITY BAR (strict):
//   - Do not produce word-dump answers.
//   - Do not produce one-line answers unless the question is definition-only and still exam-ready.
//   - Every answer must be scan-friendly with short paragraphs or flat bullets.
//   - Never use meta-writing phrases like "In exam, write..." or "You can mention...".
// - Give each answer this flow (mandatory):
//   1) direct concept statement,
//   2) short working/mechanism explanation,
//   3) tiny practical example.
// - Decide contextually for code examples:
//   - If the subject/question is technical, include a short fenced code block (3-10 lines) in most answers, especially Applied answers.
//   - Use realistic code-like snippets, not pseudo placeholders.
//   - Place one short explanation line before or after the code block to connect it to the answer.
//   - If the subject/question is non-technical, avoid code blocks and use short step-wise explanation with a tiny practical example.
// - Explanation writing quality:
//   - Topic explanations: 2 short paragraphs preferred (what+why, then how) with simple words.
//   - Subtopic explanations: 2 short paragraphs preferred with one tiny concrete use-case.
//   - Keep "example_block" quick and faithful to the same concept; use backticks for API names/syntax/formulas.
// - If original marks are known from replica/sections, map marks to labels as:
//   1-3 marks => Foundational, 4+ marks => Applied.

// SAFE CHUNKED GENERATION — INTERNAL MULTI-PASS STRATEGY (MANDATORY WHEN OUTPUT IS LARGE):
// If the output is large or risks truncation, internally execute generation in multiple passes while still returning ONE final JSON. Do NOT output intermediate passes or mention them.

// PASS 1 — STRUCTURE LOCK:
// - Copy STRUCTURE into "units" exactly.
// - Do not generate explanations or questions yet.
// - Preserve hierarchy strictly.

// PASS 2 — TOPIC LAYER:
// - Fill ONLY topic-level fields: explanation, example_block, support_note, learning_goal, prerequisite_titles, next_recommended_titles.
// - Do NOT fill subtopics yet.

// PASS 3 — SUBTOPIC LAYER:
// - Fill all subtopic fields completely.
// - Ensure linkage fields (prerequisite_titles, next_recommended_titles) are valid and minimal.

// PASS 4 — FINAL CONSOLIDATION:
// - Merge all internally generated parts into ONE final JSON.
// - Ensure no section is missing or partially generated.

// CHUNKED GENERATION RULES:
// - Do NOT output intermediate passes.
// - Do NOT mention passes in the final output.
// - Do NOT restart generation from scratch unless structure is invalid.
// - Maintain consistency across passes (no contradictions).
// - Ensure no duplication or overwriting of previously generated sections.
// - Always prioritize completing missing sections over regenerating existing ones.
// - FAIL-SAFE: If generation is interrupted or nearing limits, continue from the last incomplete section instead of restarting.

// FINAL SELF-CHECK BEFORE OUTPUT (must pass all):
// 1) JSON parses without error.
// 2) units preserve the same hierarchy from STRUCTURE.
// 3) questions.length === ${totalQuestionTarget}
// 4) count(isStarred=true) === ${effectiveStarTarget}
// 5) all mandatory replica questions are present.
// 6) no duplicate question text after normalization.
// If any check fails, fix it before returning final JSON.

// GENERATION PROCEDURE (follow in order):
// Step A) Copy STRUCTURE into "units" exactly.
// Step B) If mode is "explanations_only": add explanations and keep "questions": [].
// Step C) If mode is "questions_only": keep unit/topic/subtopic titles unchanged and generate only questions. Do not rewrite explanations beyond minimal placeholders.
// Step D) If mode is "explanations_and_questions": add high-quality explanations and questions.
// Step E) For question modes, start "questions" by inserting all MANDATORY_REPLICA_QUESTIONS first.
// Step F) Add exactly ${remainingQuestionsNeeded} new questions so total becomes ${totalQuestionTarget}.
// Step G) Keep total starred at exactly ${effectiveStarTarget}. Mandatory replicas are already starred.
// Step H) Re-check JSON validity and all counts before final answer.

// HARD FAILURE RULES:
// - If mode is explanations_only, "questions" must be [].
// - If mode is question mode, never return fewer or more than ${totalQuestionTarget} questions.
// - If mode is question mode, never omit mandatory replica questions.
// - Never change question text of mandatory replica questions.

// FINAL OUTPUT REQUIREMENT:
// - Return exactly ONE valid JSON object.
// - No additional text before or after JSON.
// - Must pass all previously defined constraints and self-checks.

// STRUCTURE:
// ${JSON.stringify(structureWithFacts, null, 2)}

// MANDATORY_REPLICA_QUESTIONS:
// ${JSON.stringify(pkg.replicaQuestions, null, 2)}
// `;

    res.json({
      success: true,
      configId: pkg.configId,
      subject: pkg.subject,
      structure: pkg.structure,
      factGrounding: pkg.factGrounding,
      replicaQuestions: pkg.replicaQuestions,
      warnings: pkg.warnings,
      replicaExtraction: pkg.replicaExtraction,
      totalQuestionTarget,
      mode,
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
    const forceOverwrite = Boolean((rawBody as any)?.forceOverwrite);
    const overwritePolicy: OverwritePolicy = forceOverwrite ? "force_overwrite" : "preserve_existing";
    if (body.subject && normalizeText(body.subject) !== normalizeText(pkg.subject)) {
      throw new Error(`Import subject mismatch. Expected "${pkg.subject}" but got "${body.subject}".`);
    }
    const importMode = body.mode;
    const isQuestionsOnlyImport = importMode === "questions_only";
    const isExplanationsOnlyImport = importMode === "explanations_only";
    const warnings: string[] = [];
    warnings.push(`Import policy: ${overwritePolicy === "force_overwrite" ? "force overwrite enabled" : "preserve existing canonical content"}.`);
    const reusableExplanationMap = await loadReusableExplanationMap(pkg.subject, id);
    let reusedExplanations = 0;
    let generatedExplanations = 0;

    if (!isQuestionsOnlyImport && body.units.length === 0) {
      body.units = pkg.structure.map((u) => ({
        title: u.title,
        topics: u.topics.map((t) => ({
          title: t.title,
          explanation: "",
          learning_goal: "",
          example_block: "",
          support_note: "",
          prerequisite_titles: [],
          prerequisite_node_ids: [],
          next_recommended_titles: [],
          next_recommended_node_ids: [],
          subtopics: t.subtopics.map((s) => ({
            title: s,
            explanation: "",
            learning_goal: "",
            example_block: "",
            support_note: "",
            prerequisite_titles: [],
            prerequisite_node_ids: [],
            next_recommended_titles: [],
            next_recommended_node_ids: [],
          })),
        })),
      }));
      warnings.push("No valid units found in import JSON. Used lane A structure and will auto-fill explanations.");
    }

    const questions = isExplanationsOnlyImport ? [] : [...body.questions];

    setCheapImportProgress(id, {
      stage: "saving_structure",
      totalQuestions: questions.length,
      processedQuestions: 0,
      message: `Saving units, topics, and subtopics (${overwritePolicy})...`,
      warnings,
      overwritePolicy,
    });

    const pathMap = new Map<string, { nodeId: string; unitSubtopicId: string }>();
    let processedQuestions = 0;

    const persistQuestions = async (tx: any) => {
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const key = `${normalizeText(q.unitTitle)}|${normalizeText(q.topicTitle)}|${normalizeText(q.subtopicTitle)}`;
        const mapped = pathMap.get(key);
        if (!mapped) {
          if (isQuestionsOnlyImport) {
            throw new Error(
              `Question mapping failed for "${q.question}" at ${q.unitTitle} > ${q.topicTitle} > ${q.subtopicTitle}.`,
            );
          }
          continue;
        }

        await tx.insert(configQuestionsTable).values({
          configId: id,
          unitSubtopicId: mapped.unitSubtopicId,
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
    };

    if (isQuestionsOnlyImport) {
      await db.transaction(async (tx) => {
        const existingNodes = await tx
          .select({
            id: nodesTable.id,
            title: nodesTable.title,
            type: nodesTable.type,
            parentId: nodesTable.parentId,
            unitSubtopicId: nodesTable.unitSubtopicId,
            configId: nodesTable.configId,
          })
          .from(nodesTable)
          .where(eq(nodesTable.configId, id));

        const nodeById = new Map(existingNodes.map((n) => [n.id, n]));
        for (const node of existingNodes) {
          if (node.type !== "subtopic") continue;
          const subtopicId = String(node.unitSubtopicId || "").trim();
          if (!subtopicId) continue;
          const topic = node.parentId ? nodeById.get(node.parentId) : null;
          const unit = topic?.parentId ? nodeById.get(topic.parentId) : null;
          if (!topic || !unit) continue;
          const key = `${normalizeText(unit.title)}|${normalizeText(topic.title)}|${normalizeText(node.title)}`;
          pathMap.set(key, { nodeId: node.id, unitSubtopicId: subtopicId });
        }

        if (pathMap.size === 0) {
          throw new Error("No existing subtopic chain found for questions_only import. Generate explanations/structure first.");
        }

        await tx.delete(configQuestionsTable).where(eq(configQuestionsTable.configId, id));
        warnings.push("questions_only mode: existing question bank replaced; structure and explanations were preserved.");
        await persistQuestions(tx);
      });
    } else {
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
              sourceText: null,
              createdBy: userId,
            });
            unitLibraryIdByNormTitle.set(normalizedUnitTitle, createdId);
          }
        }

        for (let ui = 0; ui < body.units.length; ui++) {
          const unit = body.units[ui];
          const unitLibraryId = unitLibraryIdByNormTitle.get(normalizeText(unit.title));
          if (!unitLibraryId) continue;
          const canonUnitId = canonicalUnitId(subject.id, unit.title);
          const unitId = scopedNodeId(id, canonUnitId);
          await tx
            .insert(canonicalNodesTable)
            .values({
              id: canonUnitId,
              subjectId: subject.id,
              unitLibraryId,
              title: unit.title,
              normalizedTitle: normalizeText(unit.title),
              type: "unit",
              parentCanonicalNodeId: null,
              sortOrder: ui + 1,
            })
            .onConflictDoUpdate({
              target: [canonicalNodesTable.id],
              set: {
                title: unit.title,
                normalizedTitle: normalizeText(unit.title),
                unitLibraryId,
                sortOrder: ui + 1,
                updatedAt: new Date(),
              },
            });
          await tx.insert(nodesTable).values({
            id: unitId,
            configId: id,
            canonicalNodeId: canonUnitId,
            subjectId: subject.id,
            unitLibraryId,
            title: unit.title,
            normalizedTitle: normalizeText(unit.title),
            type: "unit",
            parentId: null,
            sortOrder: ui + 1,
          });

          for (let ti = 0; ti < unit.topics.length; ti++) {
            const topic = unit.topics[ti];
            const canonTopicId = canonicalTopicId(subject.id, unit.title, topic.title);
            const topicId = scopedNodeId(id, canonTopicId);
            let topicCoreExplanation = (topic.explanation || "").trim();
            if (!topicCoreExplanation) {
              try {
                topicCoreExplanation = await generateTopicExplanation(
                  pkg.subject,
                  unit.title,
                  topic.title,
                );
              } catch {
                topicCoreExplanation = "Topic summary will be updated soon.";
              }
            }
            const topicExplanation = normalizeCoreExplanation(topicCoreExplanation);

            const unitTopicId = canonTopicId;

            const [existingCanonicalTopic] = await tx
              .select({
                explanation: canonicalNodesTable.explanation,
                learningGoal: canonicalNodesTable.learningGoal,
                exampleBlock: canonicalNodesTable.exampleBlock,
                supportNote: canonicalNodesTable.supportNote,
                prerequisiteTitles: canonicalNodesTable.prerequisiteTitles,
                prerequisiteNodeIds: canonicalNodesTable.prerequisiteNodeIds,
                nextRecommendedTitles: canonicalNodesTable.nextRecommendedTitles,
                nextRecommendedNodeIds: canonicalNodesTable.nextRecommendedNodeIds,
              })
              .from(canonicalNodesTable)
              .where(eq(canonicalNodesTable.id, canonTopicId))
              .limit(1);

            const topicPrereqTitles = topic.prerequisite_titles?.length
              ? topic.prerequisite_titles
              : ti > 0
                ? [unit.topics[ti - 1].title]
                : [];
            const topicPrereqNodeIds = topic.prerequisite_node_ids?.length
              ? topic.prerequisite_node_ids
              : ti > 0
                ? [canonicalTopicId(subject.id, unit.title, unit.topics[ti - 1].title)]
                : [];
            const topicNextTitles = topic.next_recommended_titles?.length
              ? topic.next_recommended_titles
              : ti < unit.topics.length - 1
                ? [unit.topics[ti + 1].title]
                : [];
            const topicNextNodeIds = topic.next_recommended_node_ids?.length
              ? topic.next_recommended_node_ids
              : ti < unit.topics.length - 1
                ? [canonicalTopicId(subject.id, unit.title, unit.topics[ti + 1].title)]
                : [];

            const mergedTopicExplanation = mergeImportedText(existingCanonicalTopic?.explanation, topicExplanation, forceOverwrite);
            const mergedTopicLearningGoal = mergeImportedText(existingCanonicalTopic?.learningGoal, String(topic.learning_goal || "").trim(), forceOverwrite);
            const mergedTopicExample = mergeImportedText(existingCanonicalTopic?.exampleBlock, String(topic.example_block || "").trim(), forceOverwrite);
            const mergedTopicSupportNote = mergeImportedText(existingCanonicalTopic?.supportNote, String(topic.support_note || "").trim(), forceOverwrite);
            const mergedTopicPrereqTitles = mergeImportedArray(existingCanonicalTopic?.prerequisiteTitles, topicPrereqTitles, forceOverwrite);
            const mergedTopicPrereqNodeIds = mergeImportedArray(existingCanonicalTopic?.prerequisiteNodeIds, topicPrereqNodeIds, forceOverwrite);
            const mergedTopicNextTitles = mergeImportedArray(existingCanonicalTopic?.nextRecommendedTitles, topicNextTitles, forceOverwrite);
            const mergedTopicNextNodeIds = mergeImportedArray(existingCanonicalTopic?.nextRecommendedNodeIds, topicNextNodeIds, forceOverwrite);

            await tx
              .insert(canonicalNodesTable)
              .values({
                id: canonTopicId,
                subjectId: subject.id,
                unitLibraryId,
                title: topic.title,
                normalizedTitle: normalizeText(topic.title),
                type: "topic",
                parentCanonicalNodeId: canonUnitId,
                explanation: mergedTopicExplanation,
                learningGoal: mergedTopicLearningGoal,
                exampleBlock: mergedTopicExample,
                supportNote: mergedTopicSupportNote,
                prerequisiteTitles: mergedTopicPrereqTitles,
                prerequisiteNodeIds: mergedTopicPrereqNodeIds,
                nextRecommendedTitles: mergedTopicNextTitles,
                nextRecommendedNodeIds: mergedTopicNextNodeIds,
                sortOrder: ti + 1,
              })
              .onConflictDoUpdate({
                target: [canonicalNodesTable.id],
                set: {
                  unitLibraryId,
                  title: topic.title,
                  normalizedTitle: normalizeText(topic.title),
                  parentCanonicalNodeId: canonUnitId,
                  explanation: mergedTopicExplanation,
                  learningGoal: mergedTopicLearningGoal,
                  exampleBlock: mergedTopicExample,
                  supportNote: mergedTopicSupportNote,
                  prerequisiteTitles: mergedTopicPrereqTitles,
                  prerequisiteNodeIds: mergedTopicPrereqNodeIds,
                  nextRecommendedTitles: mergedTopicNextTitles,
                  nextRecommendedNodeIds: mergedTopicNextNodeIds,
                  sortOrder: ti + 1,
                  updatedAt: new Date(),
                },
              });

            await tx.insert(nodesTable).values({
              id: topicId,
              configId: id,
              canonicalNodeId: canonTopicId,
              subjectId: subject.id,
              unitLibraryId,
              title: topic.title,
              normalizedTitle: normalizeText(topic.title),
              type: "topic",
              parentId: unitId,
              explanation: mergedTopicExplanation,
              learningGoal: mergedTopicLearningGoal,
              exampleBlock: mergedTopicExample,
              supportNote: mergedTopicSupportNote,
              prerequisiteTitles: mergedTopicPrereqTitles,
              prerequisiteNodeIds: toStoredArrayValue(
                topic.prerequisite_node_ids?.length
                  ? topic.prerequisite_node_ids
                  : ti > 0
                    ? [scopedNodeId(id, canonicalTopicId(subject.id, unit.title, unit.topics[ti - 1].title))]
                    : []
              ),
              nextRecommendedTitles: mergedTopicNextTitles,
              nextRecommendedNodeIds: toStoredArrayValue(
                topic.next_recommended_node_ids?.length
                  ? topic.next_recommended_node_ids
                  : ti < unit.topics.length - 1
                    ? [scopedNodeId(id, canonicalTopicId(subject.id, unit.title, unit.topics[ti + 1].title))]
                    : []
              ),
              unitTopicId,
              sortOrder: ti + 1,
            });

            for (let si = 0; si < topic.subtopics.length; si++) {
              const sub = topic.subtopics[si];
              const canonSubId = canonicalSubtopicId(subject.id, unit.title, topic.title, sub.title);
              const subId = scopedNodeId(id, canonSubId);
              const key = explanationKey(unit.title, topic.title, sub.title);
              let coreExplanation = (sub.explanation || "").trim();
              if (!coreExplanation) {
                const reused = reusableExplanationMap.get(key);
                if (reused?.trim()) {
                  coreExplanation = reused;
                  reusedExplanations++;
                } else {
                  try {
                    coreExplanation = await generateSubtopicExplanation(
                      pkg.subject,
                      unit.title,
                      topic.title,
                      sub.title,
                    );
                    generatedExplanations++;
                  } catch {
                    coreExplanation = "Content will be updated soon.";
                  }
                }
              }
              const explanation = normalizeCoreExplanation(coreExplanation);

              const unitSubtopicId = canonSubId;

              const [existingCanonicalSubtopic] = await tx
                .select({
                  explanation: canonicalNodesTable.explanation,
                  learningGoal: canonicalNodesTable.learningGoal,
                  exampleBlock: canonicalNodesTable.exampleBlock,
                  supportNote: canonicalNodesTable.supportNote,
                  prerequisiteTitles: canonicalNodesTable.prerequisiteTitles,
                  prerequisiteNodeIds: canonicalNodesTable.prerequisiteNodeIds,
                  nextRecommendedTitles: canonicalNodesTable.nextRecommendedTitles,
                  nextRecommendedNodeIds: canonicalNodesTable.nextRecommendedNodeIds,
                })
                .from(canonicalNodesTable)
                .where(eq(canonicalNodesTable.id, canonSubId))
                .limit(1);

              const subPrereqTitles = sub.prerequisite_titles?.length
                ? sub.prerequisite_titles
                : si > 0
                  ? [topic.subtopics[si - 1].title]
                  : [];
              const subPrereqNodeIds = sub.prerequisite_node_ids?.length
                ? sub.prerequisite_node_ids
                : si > 0
                  ? [canonicalSubtopicId(subject.id, unit.title, topic.title, topic.subtopics[si - 1].title)]
                  : [];
              const subNextTitles = sub.next_recommended_titles?.length
                ? sub.next_recommended_titles
                : si < topic.subtopics.length - 1
                  ? [topic.subtopics[si + 1].title]
                  : [];
              const subNextNodeIds = sub.next_recommended_node_ids?.length
                ? sub.next_recommended_node_ids
                : si < topic.subtopics.length - 1
                  ? [canonicalSubtopicId(subject.id, unit.title, topic.title, topic.subtopics[si + 1].title)]
                  : [];

              const mergedSubExplanation = mergeImportedText(existingCanonicalSubtopic?.explanation, explanation, forceOverwrite);
              const mergedSubLearningGoal = mergeImportedText(existingCanonicalSubtopic?.learningGoal, String(sub.learning_goal || "").trim(), forceOverwrite);
              const mergedSubExample = mergeImportedText(existingCanonicalSubtopic?.exampleBlock, String(sub.example_block || "").trim(), forceOverwrite);
              const mergedSubSupportNote = mergeImportedText(existingCanonicalSubtopic?.supportNote, String(sub.support_note || "").trim(), forceOverwrite);
              const mergedSubPrereqTitles = mergeImportedArray(existingCanonicalSubtopic?.prerequisiteTitles, subPrereqTitles, forceOverwrite);
              const mergedSubPrereqNodeIds = mergeImportedArray(existingCanonicalSubtopic?.prerequisiteNodeIds, subPrereqNodeIds, forceOverwrite);
              const mergedSubNextTitles = mergeImportedArray(existingCanonicalSubtopic?.nextRecommendedTitles, subNextTitles, forceOverwrite);
              const mergedSubNextNodeIds = mergeImportedArray(existingCanonicalSubtopic?.nextRecommendedNodeIds, subNextNodeIds, forceOverwrite);

              await tx
                .insert(canonicalNodesTable)
                .values({
                  id: canonSubId,
                  subjectId: subject.id,
                  unitLibraryId,
                  title: sub.title,
                  normalizedTitle: normalizeText(sub.title),
                  type: "subtopic",
                  parentCanonicalNodeId: canonTopicId,
                  explanation: mergedSubExplanation,
                  learningGoal: mergedSubLearningGoal,
                  exampleBlock: mergedSubExample,
                  supportNote: mergedSubSupportNote,
                  prerequisiteTitles: mergedSubPrereqTitles,
                  prerequisiteNodeIds: mergedSubPrereqNodeIds,
                  nextRecommendedTitles: mergedSubNextTitles,
                  nextRecommendedNodeIds: mergedSubNextNodeIds,
                  sortOrder: si + 1,
                })
                .onConflictDoUpdate({
                  target: [canonicalNodesTable.id],
                  set: {
                    unitLibraryId,
                    title: sub.title,
                    normalizedTitle: normalizeText(sub.title),
                    parentCanonicalNodeId: canonTopicId,
                    explanation: mergedSubExplanation,
                    learningGoal: mergedSubLearningGoal,
                    exampleBlock: mergedSubExample,
                    supportNote: mergedSubSupportNote,
                    prerequisiteTitles: mergedSubPrereqTitles,
                    prerequisiteNodeIds: mergedSubPrereqNodeIds,
                    nextRecommendedTitles: mergedSubNextTitles,
                    nextRecommendedNodeIds: mergedSubNextNodeIds,
                    sortOrder: si + 1,
                    updatedAt: new Date(),
                  },
                });

              await tx.insert(nodesTable).values({
                id: subId,
                configId: id,
                canonicalNodeId: canonSubId,
                subjectId: subject.id,
                unitLibraryId,
                title: sub.title,
                normalizedTitle: normalizeText(sub.title),
                type: "subtopic",
                parentId: topicId,
                explanation: mergedSubExplanation,
                learningGoal: mergedSubLearningGoal,
                exampleBlock: mergedSubExample,
                supportNote: mergedSubSupportNote,
                prerequisiteTitles: mergedSubPrereqTitles,
                prerequisiteNodeIds: toStoredArrayValue(
                  sub.prerequisite_node_ids?.length
                    ? sub.prerequisite_node_ids
                    : si > 0
                      ? [scopedNodeId(id, canonicalSubtopicId(subject.id, unit.title, topic.title, topic.subtopics[si - 1].title))]
                      : []
                ),
                nextRecommendedTitles: mergedSubNextTitles,
                nextRecommendedNodeIds: toStoredArrayValue(
                  sub.next_recommended_node_ids?.length
                    ? sub.next_recommended_node_ids
                    : si < topic.subtopics.length - 1
                      ? [scopedNodeId(id, canonicalSubtopicId(subject.id, unit.title, topic.title, topic.subtopics[si + 1].title))]
                      : []
                ),
                unitTopicId,
                unitSubtopicId,
                sortOrder: si + 1,
              });
              pathMap.set(key, { nodeId: subId, unitSubtopicId });
            }
          }
        }
        await persistQuestions(tx);
      });
    }

    if (!isExplanationsOnlyImport) {
      setCheapImportProgress(id, {
        stage: "saving_questions",
        message: "Saving question bank...",
      });
    }

    setCheapImportProgress(id, {
      stage: "finalizing",
      processedQuestions,
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
      .select({
        id: configsTable.id,
        status: configsTable.status,
        subject: configsTable.subject,
      })
      .from(configsTable)
      .where(eq(configsTable.id, id))
      .limit(1);

    if (!config) {
      res.status(404).json({ error: "Config not found" });
      return;
    }

    if (config.status !== "draft") {
      res.status(400).json({
        error:
          config.status === "live"
            ? "Live configs cannot be disabled. Move it to draft first."
            : "Only draft configs can be disabled.",
      });
      return;
    }

    // Disable only: keep units/topics/subtopics + explanations + Q&A + events for reuse.
    await db
      .update(configsTable)
      .set({ status: "disabled", updatedAt: new Date() })
      .where(eq(configsTable.id, id));

    res.json({ success: true, disabled: true });
  } catch (error) {
    req.log.error({ err: error }, "Failed to delete config");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/configs/:id/permanent", requireAdmin, async (req, res) => {
  try {
    const { id } = PublishConfigParams.parse(req.params);
    const actorUserId = String((req as any).userId || "").trim() || "unknown";

    const [config] = await db
      .select({
        id: configsTable.id,
        status: configsTable.status,
        universityId: configsTable.universityId,
        year: configsTable.year,
        branch: configsTable.branch,
        subject: configsTable.subject,
        exam: configsTable.exam,
      })
      .from(configsTable)
      .where(eq(configsTable.id, id))
      .limit(1);

    if (!config) {
      res.status(404).json({ error: "Config not found" });
      return;
    }

    if (config.status !== "disabled") {
      res.status(400).json({ error: "Only disabled configs can be permanently deleted." });
      return;
    }

    const [nodeRows, questionRows, eventRows, unitLinkRows] = await Promise.all([
      db.select({ id: nodesTable.id }).from(nodesTable).where(eq(nodesTable.configId, id)),
      db.select({ id: configQuestionsTable.id }).from(configQuestionsTable).where(eq(configQuestionsTable.configId, id)),
      db.select({ id: eventsTable.id }).from(eventsTable).where(eq(eventsTable.configId, id)),
      db.select({ configId: configUnitLinksTable.configId }).from(configUnitLinksTable).where(eq(configUnitLinksTable.configId, id)),
    ]);

    req.log.info(
      {
        action: "config.permanent_delete.requested",
        actorUserId,
        config: {
          id: config.id,
          universityId: config.universityId,
          year: config.year,
          branch: config.branch,
          subject: config.subject,
          exam: config.exam,
          status: config.status,
        },
        impact: {
          nodes: nodeRows.length,
          questions: questionRows.length,
          events: eventRows.length,
          unitLinks: unitLinkRows.length,
        },
      },
      "Permanent delete requested for disabled config",
    );

    await db.transaction(async (tx) => {
      await tx.delete(configQuestionsTable).where(eq(configQuestionsTable.configId, id));
      await tx.delete(nodesTable).where(eq(nodesTable.configId, id));
      await tx.delete(configUnitLinksTable).where(eq(configUnitLinksTable.configId, id));
      await tx.delete(eventsTable).where(eq(eventsTable.configId, id));
      await tx.delete(configsTable).where(eq(configsTable.id, id));
    });

    req.log.info(
      {
        action: "config.permanent_delete.completed",
        actorUserId,
        configId: id,
      },
      "Permanent delete completed",
    );

    res.json({ success: true, deleted: true });
  } catch (error) {
    req.log.error({ err: error }, "Failed to permanently delete config");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/configs/:id/cheap/gap-report", requireAdmin, async (req, res) => {
  try {
    const { id } = TriggerGenerationParams.parse(req.params);
    const mode = parseCheapGenerationMode(req.query.mode);
    const includeExplanationGaps = mode !== "questions_only";
    const includeQuestionGaps = mode !== "explanations_only";

    const [config] = await db
      .select({ id: configsTable.id, exam: configsTable.exam })
      .from(configsTable)
      .where(eq(configsTable.id, id))
      .limit(1);
    if (!config) {
      res.status(404).json({ error: "Config not found" });
      return;
    }

    const expectedQuestionCount = config.exam === "endsem" ? 75 : 50;
    const existingQuestionCount = includeQuestionGaps
      ? (await db
          .select({ id: configQuestionsTable.id })
          .from(configQuestionsTable)
          .where(eq(configQuestionsTable.configId, id))).length
      : 0;
    const questionGapCount = includeQuestionGaps
      ? Math.max(0, expectedQuestionCount - existingQuestionCount)
      : 0;

    const links = await db
      .select({
        unitLibraryId: configUnitLinksTable.unitLibraryId,
        sortOrder: configUnitLinksTable.sortOrder,
      })
      .from(configUnitLinksTable)
      .where(eq(configUnitLinksTable.configId, id));

    links.sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
    const unitIds = links.map((l) => l.unitLibraryId);

    const units = unitIds.length > 0
      ? await db
          .select({
            id: unitLibraryTable.id,
            unitTitle: unitLibraryTable.unitTitle,
            topics: unitLibraryTable.topics,
          })
          .from(unitLibraryTable)
          .where(inArray(unitLibraryTable.id, unitIds))
      : [];

    const unitById = new Map(units.map((u) => [u.id, u]));
    const canonicalRows = unitIds.length > 0
      ? await db
          .select({
            id: canonicalNodesTable.id,
            unitLibraryId: canonicalNodesTable.unitLibraryId,
            title: canonicalNodesTable.title,
            type: canonicalNodesTable.type,
            parentCanonicalNodeId: canonicalNodesTable.parentCanonicalNodeId,
            explanation: canonicalNodesTable.explanation,
            learningGoal: canonicalNodesTable.learningGoal,
            exampleBlock: canonicalNodesTable.exampleBlock,
            supportNote: canonicalNodesTable.supportNote,
            sortOrder: canonicalNodesTable.sortOrder,
          })
          .from(canonicalNodesTable)
          .where(inArray(canonicalNodesTable.unitLibraryId, unitIds))
      : [];

    const existingNodes = await db
      .select({
        id: nodesTable.id,
        title: nodesTable.title,
        type: nodesTable.type,
        parentId: nodesTable.parentId,
      })
      .from(nodesTable)
      .where(eq(nodesTable.configId, id));
    const missingFields = (node: any) => {
      const missing: string[] = [];
      if (!String(node?.explanation || "").trim()) missing.push("explanation");
      if (!String(node?.learningGoal || "").trim()) missing.push("learningGoal");
      if (!String(node?.exampleBlock || "").trim()) missing.push("exampleBlock");
      if (!String(node?.supportNote || "").trim()) missing.push("supportNote");
      return missing;
    };

    const rows: Array<{
      level: "topic" | "subtopic";
      unitTitle: string;
      topicTitle: string;
      subtopicTitle?: string;
      missing: string[];
    }> = [];

    let totalTopicTargets = 0;
    let totalSubtopicTargets = 0;

    const canonicalByParent = new Map<string, typeof canonicalRows>();
    for (const n of canonicalRows) {
      const key = String(n.parentCanonicalNodeId || "");
      const list = canonicalByParent.get(key) ?? [];
      list.push(n);
      canonicalByParent.set(key, list);
    }
    const sortByOrderThenTitle = (a: any, b: any) =>
      Number(a.sortOrder || 0) - Number(b.sortOrder || 0) ||
      String(a.title || "").localeCompare(String(b.title || ""));

    const scopedUnitsByLibraryId = new Map<string, typeof existingNodes>();
    for (const n of existingNodes.filter((n) => n.type === "unit")) {
      const normalizedTitle = normalizeText(n.title);
      const matched = units.find((u) => normalizeText(u.unitTitle) === normalizedTitle);
      if (!matched) continue;
      const list = scopedUnitsByLibraryId.get(matched.id) ?? [];
      list.push(n);
      scopedUnitsByLibraryId.set(matched.id, list);
    }

    for (const uid of unitIds) {
      const selectedUnit = unitById.get(uid);
      const unitTitle = String(selectedUnit?.unitTitle || "").trim() || uid;

      const canonicalUnit = canonicalRows
        .filter((n) => n.type === "unit" && n.unitLibraryId === uid)
        .sort(sortByOrderThenTitle)[0];

      if (!canonicalUnit) {
        rows.push({
          level: "topic",
          unitTitle,
          topicTitle: "(unit root missing in canonical_nodes)",
          missing: ["node"],
        });
        continue;
      }

      const topicNodes = (canonicalByParent.get(canonicalUnit.id) ?? [])
        .filter((n) => n.type === "topic")
        .sort(sortByOrderThenTitle);
      totalTopicTargets += topicNodes.length;

      if (topicNodes.length === 0) {
        rows.push({
          level: "topic",
          unitTitle,
          topicTitle: "(no canonical topics under selected unit)",
          missing: ["node"],
        });
        continue;
      }

      const hasScopedUnitNode = (scopedUnitsByLibraryId.get(uid) ?? []).length > 0;
      for (const topicNode of topicNodes) {
        const topicMissing = includeExplanationGaps
          ? (!hasScopedUnitNode ? ["node"] : missingFields(topicNode))
          : [];
        if (topicMissing.length > 0) {
          rows.push({
            level: "topic",
            unitTitle,
            topicTitle: topicNode.title,
            missing: topicMissing,
          });
        }

        const subtopicNodes = (canonicalByParent.get(topicNode.id) ?? [])
          .filter((n) => n.type === "subtopic")
          .sort(sortByOrderThenTitle);
        totalSubtopicTargets += subtopicNodes.length;

        for (const subtopicNode of subtopicNodes) {
          const subMissing = includeExplanationGaps
            ? (!hasScopedUnitNode ? ["node"] : missingFields(subtopicNode))
            : [];
          if (subMissing.length > 0) {
            rows.push({
              level: "subtopic",
              unitTitle,
              topicTitle: topicNode.title,
              subtopicTitle: subtopicNode.title,
              missing: subMissing,
            });
          }
        }
      }
    }

    const topicGapCount = rows.filter((r) => r.level === "topic").length;
    const subtopicGapCount = rows.filter((r) => r.level === "subtopic").length;

    res.json({
      success: true,
      configId: id,
      mode,
      summary: {
        totalTopicTargets,
        totalSubtopicTargets,
        topicGapCount,
        subtopicGapCount,
        totalGapRows: rows.length,
        includeExplanationGaps,
        includeQuestionGaps,
        expectedQuestionCount,
        existingQuestionCount,
        questionGapCount,
      },
      rows,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to build cheap gap report");
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;



