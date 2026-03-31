import {
  db,
  configsTable,
  nodesTable,
  subtopicContentsTable,
  subtopicQuestionsTable,
  configUnitLinksTable,
  unitLibraryTable,
} from "../db";
import { eq, inArray } from "drizzle-orm";
import { askAI, askAIWithImage } from "./ai";
import { extractTextFromPdf, isImageMimeType, isPdfMimeType } from "./pdfExtractor";
import { ObjectStorageService } from "./objectStorage";
import { downloadSupabaseObject, isSupabaseObjectPath } from "./supabaseStorage";
import { logger } from "./logger";
import { parseFirstModelJsonObject } from "./parseModelJson";
import { randomUUID } from "crypto";
import { repairBrokenFormulaBullets } from "./textFormatting";

interface GenerationProgress {
  configId: string;
  status: "idle" | "parsing" | "generating" | "complete" | "error";
  progress: number;
  total: number;
  currentStep: string;
  error: string | null;
}

const progressMap = new Map<string, GenerationProgress>();

export function getProgress(configId: string): GenerationProgress {
  return (
    progressMap.get(configId) || {
      configId,
      status: "idle",
      progress: 0,
      total: 0,
      currentStep: "Not started",
      error: null,
    }
  );
}

function setProgress(configId: string, updates: Partial<GenerationProgress>) {
  const current = getProgress(configId);
  progressMap.set(configId, { ...current, ...updates });
}

interface ParsedTopic {
  title: string;
  subtopics: string[];
}

interface ParsedSyllabus {
  units: {
    title: string;
    topics: ParsedTopic[];
  }[];
}

type UnitLibraryTopics = {
  title: string;
  subtopics: string[];
};

type QuestionLevel = "Foundational" | "Applied";
type QuestionOrigin = "replica" | "pattern" | "generated";

interface GeneratedQuestion {
  markType: QuestionLevel;
  question: string;
  answer: string;
  unitTitle: string;
  topicTitle: string;
  subtopicTitle: string;
  isStarred: boolean;
  starSource: "auto" | "none";
  origin: QuestionOrigin;
}

function isSubpartOnlyQuestionText(value: string): boolean {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return false;
  return /^\([a-z]\)\s+/i.test(text);
}

function mergeSubpartReplicaQuestions(questions: GeneratedQuestion[]): GeneratedQuestion[] {
  if (questions.length <= 1) return questions;

  const merged: GeneratedQuestion[] = [];
  for (const question of questions) {
    if (isSubpartOnlyQuestionText(question.question) && merged.length > 0) {
      const prev = merged[merged.length - 1];
      prev.question = `${prev.question}\n${question.question}`.trim();

      if (question.answer && question.answer.trim() && question.answer.trim() !== prev.answer.trim()) {
        prev.answer = `${prev.answer}\n${question.answer}`.trim();
      }

      if (question.markType === "Applied") prev.markType = "Applied";
      prev.isStarred = prev.isStarred || question.isStarred;
      continue;
    }
    merged.push({ ...question });
  }

  return merged;
}

interface SubtopicCatalogItem {
  nodeId: string;
  unitTitle: string;
  topicTitle: string;
  subtopicTitle: string;
  normUnit: string;
  normTopic: string;
  normSubtopic: string;
}

export interface LaneAReplicaQuestion {
  markType: QuestionLevel;
  question: string;
  answer: string;
  unitTitle: string;
  topicTitle: string;
  subtopicTitle: string;
  isStarred: boolean;
}

export interface LaneAStructureUnit {
  title: string;
  topics: Array<{
    title: string;
    subtopics: string[];
  }>;
}

export interface LaneAReplicaExtractionInfo {
  hasReplicaFile: boolean;
  extractedPaperTextLength: number;
  extractionMethod: "model" | "heuristic" | "none";
}

function getEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const LOW_QUOTA_MODE = String(process.env.LOW_QUOTA_MODE || "").toLowerCase() === "true";
const QUESTION_BATCH_SIZE = getEnvNumber("QUESTION_BATCH_SIZE", LOW_QUOTA_MODE ? 12 : 35);
const QUESTION_MIN_BATCH_SIZE = getEnvNumber("QUESTION_MIN_BATCH_SIZE", LOW_QUOTA_MODE ? 6 : 10);

function getTargetsForExam(exam: string): { totalQuestions: number; totalStars: number } {
  const normalizedExam = String(exam || "").toLowerCase().trim();
  if (normalizedExam.startsWith("mid")) {
    return { totalQuestions: 50, totalStars: 20 };
  }
  return { totalQuestions: 75, totalStars: 25 };
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function isLikelyQuestionText(value: string): boolean {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return false;

  const informationalPatterns = [
    /^part\s*-?\s*[a-z0-9]+\b/i,
    /^section\s*-?\s*[a-z0-9]+\b/i,
    /^answer\b/i,
    /^course outcomes?\b/i,
    /^knowledge level\b/i,
    /^blooms?\b/i,
    /^q\.?\s*no\b/i,
    /^time\b/i,
    /^marks?\b/i,
    /^or$/i,
    /^k[1-6]\s*-?\s*(remember|understand|apply|analy[sz]e|evaluate|create)\b/i,
  ];

  if (informationalPatterns.some((pattern) => pattern.test(text))) return false;

  if (
    /k1\s*-?\s*remember/i.test(text) &&
    /k2\s*-?\s*understand/i.test(text)
  ) {
    return false;
  }

  if (/\?$/.test(text)) return true;

  return /^(what|why|how|when|which|who|whom|whose|define|explain|list|state|create|write|describe|compare|differentiate|demonstrate|show|give|mention|outline|derive|implement)\b/i.test(
    text
  );
}

function explanationKey(unitTitle: string, topicTitle: string, subtopicTitle: string): string {
  return `${normalizeText(unitTitle)}|${normalizeText(topicTitle)}|${normalizeText(subtopicTitle)}`;
}

function topicExplanationKey(unitTitle: string, topicTitle: string): string {
  return `${normalizeText(unitTitle)}|${normalizeText(topicTitle)}`;
}

type ParsedReplicaQuestion = {
  qNo: number;
  text: string;
  marks: number | null;
};

type ParsedReplicaQuestionBlock = {
  qNo: number;
  variant: string | null;
  stemLines: string[];
  subparts: Array<{ label: string; lines: string[] }>;
  marks: number | null;
};

function markTypeFromMarks(marks: number | null, fallback: QuestionLevel = "Foundational"): QuestionLevel {
  if (marks == null) return fallback;
  return marks <= 3 ? "Foundational" : "Applied";
}

function parseMarksFromLine(line: string): number | null {
  const normalized = line.replace(/[–—]/g, "-");

  const xPattern = normalized.match(/(\d+)\s*[xX]\s*(\d+)/);
  if (xPattern) {
    const perQuestion = Number(xPattern[2]);
    if (Number.isFinite(perQuestion) && perQuestion > 0) return perQuestion;
  }

  const marksPattern = normalized.match(/(\d+)\s*marks?/i);
  if (marksPattern) {
    const value = Number(marksPattern[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }

  const mPattern = normalized.match(/\b(\d+)\s*[mM]\b/);
  if (mPattern) {
    const value = Number(mPattern[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }

  return null;
}

function parseReplicaQuestionsWithSections(paperText: string): ParsedReplicaQuestion[] {
  const lines = paperText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const blocks: ParsedReplicaQuestionBlock[] = [];
  let currentSectionMarks: number | null = null;
  let current: ParsedReplicaQuestionBlock | null = null;
  let activeSubpart: { label: string; lines: string[] } | null = null;

  const isSectionHeader = (line: string): boolean =>
    /(part|section)\s*[-:]?\s*[a-z0-9]+/i.test(line) ||
    /\b(short\s*answer|long\s*answer|essay|objective)\b/i.test(line);

  const isNoiseLine = (line: string): boolean => {
    const t = line.replace(/\s+/g, " ").trim();
    if (!t) return true;
    if (/^or$/i.test(t)) return true;
    if (/^(q\.?\s*no\.?|questions?|co|rbtl|blooms?|marks?|maximum|duration)\b/i.test(t)) return true;
    if (/^k[1-6]\b/i.test(t)) return true;
    if (/^\d+\s*$/.test(t)) return true;
    return false;
  };

  const flushCurrent = () => {
    if (!current) return;

    const stem = current.stemLines.join(" ").replace(/\s+/g, " ").trim();
    const renderedSubparts = current.subparts
      .map((sp) => {
        const spText = sp.lines.join(" ").replace(/\s+/g, " ").trim();
        if (!spText) return "";
        return `(${sp.label}) ${spText}`;
      })
      .filter(Boolean);

    const text = [stem, ...renderedSubparts].filter(Boolean).join("\n");
    if (text.length >= 8 && isLikelyQuestionText(text)) {
      blocks.push({
        qNo: current.qNo,
        variant: current.variant,
        stemLines: [...current.stemLines],
        subparts: current.subparts.map((sp) => ({ label: sp.label, lines: [...sp.lines] })),
        marks: current.marks,
      });
    }

    current = null;
    activeSubpart = null;
  };

  const startQuestion = (qNo: number, variant: string | null, initialText: string) => {
    flushCurrent();
    current = {
      qNo,
      variant,
      stemLines: initialText ? [initialText] : [],
      subparts: [],
      marks: currentSectionMarks,
    };
    activeSubpart = null;
  };

  const parseQuestionHeader = (
    line: string
  ): { qNo: number; variant: string | null; inlineText: string } | null => {
    const compact = line.replace(/\s+/g, " ").trim();
    const withVariantInline = compact.match(
      /^(?:q\.?\s*no\.?\s*)?(\d{1,3})\s*([a-z])[\)\.\-:\s]+(.+)$/i
    );
    if (withVariantInline) {
      return {
        qNo: Number(withVariantInline[1]),
        variant: withVariantInline[2].toLowerCase(),
        inlineText: withVariantInline[3].trim(),
      };
    }

    const plainInline = compact.match(/^(?:q\.?\s*no\.?\s*)?(\d{1,3})[\)\.\-:\s]+(.+)$/i);
    if (plainInline) {
      return {
        qNo: Number(plainInline[1]),
        variant: null,
        inlineText: plainInline[2].trim(),
      };
    }

    const onlyHeader = compact.match(/^(?:q\.?\s*no\.?\s*)?(\d{1,3})\s*([a-z])?[\)\.\-:]?$/i);
    if (onlyHeader) {
      return {
        qNo: Number(onlyHeader[1]),
        variant: onlyHeader[2] ? onlyHeader[2].toLowerCase() : null,
        inlineText: "",
      };
    }

    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (isSectionHeader(line)) {
      const sameLineMarks = parseMarksFromLine(line);
      if (sameLineMarks != null) {
        currentSectionMarks = sameLineMarks;
      } else {
        const nextMarks = parseMarksFromLine(lines[i + 1] || "") ?? parseMarksFromLine(lines[i + 2] || "");
        if (nextMarks != null) currentSectionMarks = nextMarks;
      }
      continue;
    }

    const header = parseQuestionHeader(line);
    if (header) {
      startQuestion(header.qNo, header.variant, header.inlineText);
      continue;
    }

    if (!current) continue;
    if (isNoiseLine(line)) continue;

    const subpartMatch = line.match(/^\(([a-z])\)\s*(.*)$/i);
    if (subpartMatch) {
      const label = subpartMatch[1].toLowerCase();
      const text = subpartMatch[2].trim();
      const existing = current.subparts.find((sp) => sp.label === label);
      if (existing) {
        if (text) existing.lines.push(text);
        activeSubpart = existing;
      } else {
        const created = { label, lines: text ? [text] : [] };
        current.subparts.push(created);
        activeSubpart = created;
      }
      continue;
    }

    if (activeSubpart) {
      activeSubpart.lines.push(line);
    } else {
      current.stemLines.push(line);
    }
  }

  flushCurrent();

  return blocks
    .map((block) => {
      const stem = block.stemLines.join(" ").replace(/\s+/g, " ").trim();
      const renderedSubparts = block.subparts
        .map((sp) => {
          const spText = sp.lines.join(" ").replace(/\s+/g, " ").trim();
          if (!spText) return "";
          return `(${sp.label}) ${spText}`;
        })
        .filter(Boolean);
      return {
        qNo: block.qNo,
        text: [stem, ...renderedSubparts].filter(Boolean).join("\n").trim(),
        marks: block.marks,
      };
    })
    .filter((q) => q.text.length >= 8 && isLikelyQuestionText(q.text));
}

function inferMarkTypeFromParsedReplica(
  questionText: string,
  parsed: ParsedReplicaQuestion[],
  fallback: QuestionLevel = "Foundational"
): QuestionLevel {
  if (parsed.length === 0) return fallback;
  const qNorm = normalizeText(questionText);
  if (!qNorm) return fallback;

  let best: ParsedReplicaQuestion | null = null;
  let bestScore = -1;
  for (const p of parsed) {
    const pNorm = normalizeText(p.text);
    if (!pNorm) continue;
    let score = 0;
    if (qNorm === pNorm) score += 100;
    if (qNorm.includes(pNorm) || pNorm.includes(qNorm)) score += 30;
    const pTokens = pNorm.split(" ").filter((t) => t.length > 3);
    for (const t of pTokens.slice(0, 8)) {
      if (qNorm.includes(t)) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  if (!best || bestScore < 6) return fallback;
  return markTypeFromMarks(best.marks, fallback);
}

async function askModelForJson<T>(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  label: string
): Promise<T> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const strictUserPrompt =
      attempt === 1
        ? userPrompt
        : `${userPrompt}\n\nIMPORTANT:\nReturn ONLY one valid JSON object. Do not add markdown, prose, or code fences.`;
    const strictSystemPrompt =
      attempt === 1
        ? systemPrompt
        : `${systemPrompt}\nYou MUST return exactly one valid JSON object and nothing else.`;

    try {
      const response = await askAI(strictSystemPrompt, strictUserPrompt, maxTokens, { requireJson: true });
      return parseFirstModelJsonObject<T>(response);
    } catch (error) {
      lastError = error;
      logger.warn({ err: error, label, attempt }, "Model JSON parse failed, retrying");
    }
  }

  const message = lastError instanceof Error ? lastError.message : "Unknown model JSON parse error";
  throw new Error(`${label}: ${message}`);
}

async function fetchFileContent(
  objectPath: string
): Promise<{ text?: string; imageBase64?: string; mediaType?: string }> {
  let contentType = "application/octet-stream";
  let buffer: Buffer;
  if (isSupabaseObjectPath(objectPath)) {
    const downloaded = await downloadSupabaseObject(objectPath);
    contentType = downloaded.contentType;
    buffer = downloaded.buffer;
  } else {
    const storageService = new ObjectStorageService();
    const file = await storageService.getObjectEntityFile(objectPath);
    const [metadata] = await file.getMetadata();
    contentType = (metadata.contentType as string) || "application/octet-stream";
    const [gcsBuffer] = await file.download();
    buffer = Buffer.from(gcsBuffer);
  }

  if (isPdfMimeType(contentType)) {
    const text = await extractTextFromPdf(buffer);
    return { text };
  }

  if (isImageMimeType(contentType)) {
    const base64 = buffer.toString("base64");
    return { imageBase64: base64, mediaType: contentType };
  }

  return { text: buffer.toString("utf-8") };
}

async function extractSyllabusText(config: {
  syllabusFileUrl: string | null;
}): Promise<string> {
  if (!config.syllabusFileUrl) throw new Error("No syllabus file URL");

  const content = await fetchFileContent(config.syllabusFileUrl);

  if (content.text) return content.text;

  if (content.imageBase64 && content.mediaType) {
    return askAIWithImage(
      "You are an OCR assistant. Extract all text from this image of a syllabus document. Return only the extracted text, preserving structure.",
      "Extract all text from this syllabus image.",
      content.imageBase64,
      content.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    );
  }

  throw new Error("Could not extract text from syllabus file");
}

async function extractPaperText(paperFileUrls: string[]): Promise<string> {
  const texts: string[] = [];
  for (const url of paperFileUrls) {
    try {
      const content = await fetchFileContent(url);
      if (content.text) {
        texts.push(content.text);
      } else if (content.imageBase64 && content.mediaType) {
        const text = await askAIWithImage(
          "You are an OCR assistant. Extract all text from this image of an exam question paper. Return only the extracted text.",
          "Extract all text from this question paper image.",
          content.imageBase64,
          content.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        );
        texts.push(text);
      }
    } catch (err) {
      logger.warn({ err, url }, "Failed to extract text from paper file");
    }
  }
  return texts.join("\n\n---\n\n");
}

async function parseSyllabus(
  syllabusText: string,
  subject: string
): Promise<ParsedSyllabus> {
  const prompt = `You are a syllabus parser for college exam prep. Given a syllabus for the subject "${subject}", extract its structure into units, topics, and subtopics.

Return ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "units": [
    {
      "title": "Unit 1: <unit title>",
      "topics": [
        {
          "title": "<topic title>",
          "subtopics": ["<subtopic 1>", "<subtopic 2>"]
        }
      ]
    }
  ]
}

Rules:
- Preserve original syllabus order
- Each topic should have 2-5 meaningful subtopics
- Subtopics should be specific and exam-relevant
- Keep unit/topic/subtopic titles concise`;

  return askModelForJson<ParsedSyllabus>(
    prompt,
    syllabusText,
    4000,
    "Syllabus parse failed"
  );
}

async function parseFromReusableUnits(configId: string): Promise<ParsedSyllabus | null> {
  const links = await db
    .select({
      unitLibraryId: configUnitLinksTable.unitLibraryId,
      sortOrder: configUnitLinksTable.sortOrder,
    })
    .from(configUnitLinksTable)
    .where(eq(configUnitLinksTable.configId, configId));

  if (links.length === 0) return null;

  links.sort((a, b) => (a.sortOrder || "").localeCompare(b.sortOrder || ""));
  const unitIds = links.map((l) => l.unitLibraryId);
  const units = await db
    .select({
      id: unitLibraryTable.id,
      unitTitle: unitLibraryTable.unitTitle,
      topics: unitLibraryTable.topics,
    })
    .from(unitLibraryTable)
    .where(inArray(unitLibraryTable.id, unitIds));

  const unitById = new Map(units.map((u) => [u.id, u]));
  const parsedUnits = links
    .map((link) => unitById.get(link.unitLibraryId))
    .filter((u): u is NonNullable<typeof u> => Boolean(u))
    .map((u) => ({
      title: u.unitTitle,
      topics: (u.topics as UnitLibraryTopics[] | null | undefined)?.map((t) => ({
        title: String(t?.title || "").trim(),
        subtopics: Array.isArray(t?.subtopics)
          ? t.subtopics.map((s) => String(s).trim()).filter(Boolean)
          : [],
      })).filter((t) => t.title) ?? [],
    }))
    .filter((u) => u.topics.length > 0);

  if (parsedUnits.length === 0) return null;
  return { units: parsedUnits };
}

async function loadReusableExplanationMap(
  subject: string,
  currentConfigId: string
): Promise<Map<string, string>> {
  const sameSubjectConfigs = await db
    .select({ id: configsTable.id })
    .from(configsTable)
    .where(eq(configsTable.subject, subject));

  const otherConfigIds = sameSubjectConfigs
    .map((c) => c.id)
    .filter((id) => id !== currentConfigId);

  if (otherConfigIds.length === 0) return new Map();

  const historicalNodes = await db
    .select({
      id: nodesTable.id,
      configId: nodesTable.configId,
      title: nodesTable.title,
      type: nodesTable.type,
      parentId: nodesTable.parentId,
    })
    .from(nodesTable)
    .where(inArray(nodesTable.configId, otherConfigIds));

  if (historicalNodes.length === 0) return new Map();

  const historicalNodeIds = historicalNodes.map((n) => n.id);
  const historicalContents = await db
    .select({
      nodeId: subtopicContentsTable.nodeId,
      explanation: subtopicContentsTable.explanation,
    })
    .from(subtopicContentsTable)
    .where(inArray(subtopicContentsTable.nodeId, historicalNodeIds));

  const contentByNodeId = new Map(historicalContents.map((c) => [c.nodeId, c.explanation]));
  const nodesByConfig = new Map<string, Array<typeof historicalNodes[number]>>();
  for (const node of historicalNodes) {
    const list = nodesByConfig.get(node.configId) ?? [];
    list.push(node);
    nodesByConfig.set(node.configId, list);
  }

  const reuse = new Map<string, string>();

  for (const configId of otherConfigIds) {
    const configNodes = nodesByConfig.get(configId) ?? [];
    if (configNodes.length === 0) continue;

    const nodeById = new Map(configNodes.map((n) => [n.id, n]));
    const subtopics = configNodes.filter((n) => n.type === "subtopic");

    for (const sub of subtopics) {
      const explanation = contentByNodeId.get(sub.id);
      if (!explanation?.trim()) continue;

      const topic = sub.parentId ? nodeById.get(sub.parentId) : null;
      const unit = topic?.parentId ? nodeById.get(topic.parentId) : null;
      if (!topic || !unit) continue;

      const key = explanationKey(unit.title, topic.title, sub.title);
      if (!reuse.has(key)) {
        reuse.set(key, explanation);
      }
    }
  }

  return reuse;
}

async function loadReusableTopicExplanationMap(
  subject: string,
  currentConfigId: string
): Promise<Map<string, string>> {
  const sameSubjectConfigs = await db
    .select({ id: configsTable.id })
    .from(configsTable)
    .where(eq(configsTable.subject, subject));

  const otherConfigIds = sameSubjectConfigs
    .map((c) => c.id)
    .filter((id) => id !== currentConfigId);

  if (otherConfigIds.length === 0) return new Map();

  const historicalTopics = await db
    .select({
      id: nodesTable.id,
      configId: nodesTable.configId,
      title: nodesTable.title,
      type: nodesTable.type,
      parentId: nodesTable.parentId,
      explanation: nodesTable.explanation,
    })
    .from(nodesTable)
    .where(inArray(nodesTable.configId, otherConfigIds));

  if (historicalTopics.length === 0) return new Map();

  const nodesByConfig = new Map<string, Array<typeof historicalTopics[number]>>();
  for (const node of historicalTopics) {
    const list = nodesByConfig.get(node.configId) ?? [];
    list.push(node);
    nodesByConfig.set(node.configId, list);
  }

  const reuse = new Map<string, string>();
  for (const configId of otherConfigIds) {
    const configNodes = nodesByConfig.get(configId) ?? [];
    const nodeById = new Map(configNodes.map((n) => [n.id, n]));
    const topics = configNodes.filter((n) => n.type === "topic");

    for (const topic of topics) {
      const explanation = (topic.explanation || "").trim();
      if (!explanation) continue;
      const unit = topic.parentId ? nodeById.get(topic.parentId) : null;
      if (!unit) continue;
      const key = topicExplanationKey(unit.title, topic.title);
      if (!reuse.has(key)) reuse.set(key, explanation);
    }
  }

  return reuse;
}

async function generateTopicExplanation(
  subject: string,
  unitTitle: string,
  topicTitle: string
): Promise<string> {
  const prompt = `You are an exam prep writer for "${subject}".

Write a crisp topic explanation for:
- Unit: ${unitTitle}
- Topic: ${topicTitle}

Requirements:
- 50-90 words
- Fast to revise, clear and practical
- Mention core idea + why it matters
- Include one tiny example or real use-case
- Use very simple English for first-year beginners
- Keep sentences short and direct
- Prefer 2 short paragraphs (no dense wall of text)
- Avoid jargon unless absolutely necessary
- Return plain text only.`;

  const response = await askAI(
    "You generate concise exam-ready topic explanations.",
    prompt,
    700
  );

  return repairBrokenFormulaBullets(response.trim());
}

async function generateSubtopicExplanation(
  subject: string,
  unitTitle: string,
  topicTitle: string,
  subtopicTitle: string
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
- Prefer 2-3 short paragraphs (use bullets only if it is truly a list)
- Use very simple English for first-year beginners
- Keep sentences short and direct
- Avoid jargon unless absolutely necessary
- Return plain text only.`;

  const response = await askAI(
    "You generate concise exam-ready explanations.",
    prompt,
    900
  );

  return repairBrokenFormulaBullets(response.trim());
}

async function extractReplicaQuestions(
  paperText: string,
  catalog: SubtopicCatalogItem[],
  subject: string
): Promise<{ questions: GeneratedQuestion[]; method: "model" | "heuristic" | "none"; modelError?: string }> {
  if (!paperText.trim()) return { questions: [], method: "none" };

  const catalogShort = catalog.slice(0, 120).map((c) => `${c.unitTitle} > ${c.topicTitle} > ${c.subtopicTitle}`);

  const prompt = `Extract questions from this exam paper text for subject "${subject}".

Return ONLY valid JSON:
{
  "questions": [
    {
      "markType": "Foundational" | "Applied",
      "question": "<exact question text from paper>",
      "answer": "<short exam-ready answer>",
      "unitTitle": "<best matching unit>",
      "topicTitle": "<best matching topic>",
      "subtopicTitle": "<best matching subtopic>",
      "isStarred": true
    }
  ]
}

Rules:
- Keep question text as close as possible to paper wording
- Extract only real question statements. Do NOT extract headings/instructions like Part A/Section B, Bloom levels (K1/K2...), Course Outcomes, marks tables, "Answer any...", or "Q.No".
- Keep answers concise: Foundational 25-55 words, Applied 60-110 words
- Format answers for readability:
  - Foundational: 2-4 short lines (definition + key points + one tiny real-world example when helpful), no long paragraph
  - Applied: 4-7 short lines (steps/example), no long paragraph
- Use line breaks and simple bullets (-) where useful
- Star all extracted replica questions
- Use beginner-friendly English only (no dense jargon)
- Decide contextually:
  - If the subject/question is technical and code genuinely improves clarity, you may include a short fenced code block.
  - If the subject/question is non-technical, avoid code blocks and use short step-wise explanation with a tiny practical example.
- Use only these syllabus paths for mapping when possible:
${catalogShort.join("\n")}
- Maximum 25 questions.`;

  const parsedReplica = parseReplicaQuestionsWithSections(paperText);

  try {
    const parsed = await askModelForJson<{ questions?: Array<Partial<GeneratedQuestion>> }>(
      "You extract and structure exam paper questions into strict JSON.",
      `${prompt}\n\nPAPER TEXT:\n${paperText.substring(0, 12000)}`,
      5200,
      "Replica question extraction failed"
    );
    const questions = parsed.questions ?? [];

    const mapped = questions
      .filter((q) => q.question && q.answer && isLikelyQuestionText(String(q.question)))
      .slice(0, 25)
      .map((q) => ({
        markType: inferMarkTypeFromParsedReplica(
          String(q.question || ""),
          parsedReplica,
          q.markType === "Applied" ? "Applied" : "Foundational"
        ),
        question: String(q.question || "").trim(),
        answer: String(q.answer || "").trim(),
        unitTitle: String(q.unitTitle || "").trim(),
        topicTitle: String(q.topicTitle || "").trim(),
        subtopicTitle: String(q.subtopicTitle || "").trim(),
        isStarred: true,
        starSource: "auto" as const,
        origin: "replica" as const,
      }));

    return {
      questions: mergeSubpartReplicaQuestions(mapped),
      method: "model",
    };
  } catch (err) {
    const modelError = err instanceof Error ? err.message : "Unknown model error";
    logger.warn({ err }, "Replica extraction via model failed; using heuristic fallback");
    const heuristic = (() => {
      const dedup = new Set<string>();
      const orderedCandidates = parsedReplica
        .map((p, idx) => ({ question: p.text.trim(), qNo: p.qNo, lineIndex: idx }))
        .filter(({ question }) => isLikelyQuestionText(question))
        .filter(({ question }) => {
          const key = normalizeText(question);
          if (!key || dedup.has(key)) return false;
          dedup.add(key);
          return true;
        });

      const pickBestPath = (questionText: string): SubtopicCatalogItem | null => {
        const q = normalizeText(questionText);
        let best: SubtopicCatalogItem | null = null;
        let bestScore = -1;
        for (const item of catalog) {
          let score = 0;
          for (const token of item.normSubtopic.split(" ").filter((t) => t.length > 3).slice(0, 6)) {
            if (q.includes(token)) score += 3;
          }
          for (const token of item.normTopic.split(" ").filter((t) => t.length > 3).slice(0, 5)) {
            if (q.includes(token)) score += 2;
          }
          for (const token of item.normUnit.split(" ").filter((t) => t.length > 3).slice(0, 4)) {
            if (q.includes(token)) score += 1;
          }
          if (score > bestScore) {
            best = item;
            bestScore = score;
          }
        }
        return best;
      };

      const marksByQNo = new Map(parsedReplica.map((p) => [p.qNo, p.marks]));

      return orderedCandidates.slice(0, 25).map(({ question, qNo }) => {
        const path = pickBestPath(question);
        const heuristicApplied = /\b(4m|5m|6m|8m|10m|15m|20m|4 marks|5 marks|6 marks|8 marks|10 marks|15 marks|20 marks|long answer|part[-\s]?b|section[-\s]?b)\b/i.test(question);
        const markType = markTypeFromMarks(
          qNo != null ? (marksByQNo.get(qNo) ?? null) : null,
          heuristicApplied ? "Applied" : "Foundational"
        );
        return {
          markType,
          question,
          answer: markType === "Applied"
            ? "Use a structured exam answer: definition, key points, and one short example."
            : "Use a short exam answer: one-line definition, one key point, and one tiny real-world example.",
          unitTitle: path?.unitTitle ?? (catalog[0]?.unitTitle || ""),
          topicTitle: path?.topicTitle ?? (catalog[0]?.topicTitle || ""),
          subtopicTitle: path?.subtopicTitle ?? (catalog[0]?.subtopicTitle || ""),
          isStarred: true,
          starSource: "auto" as const,
          origin: "replica" as const,
        };
      });
    })();
    return { questions: heuristic, method: "heuristic", modelError };
  }
}

export async function buildLaneAConfigPackage(configId: string): Promise<{
  configId: string;
  subject: string;
  structure: LaneAStructureUnit[];
  replicaQuestions: LaneAReplicaQuestion[];
  warnings: string[];
  replicaExtraction: LaneAReplicaExtractionInfo;
  totalQuestionTarget: number;
  totalStarTarget: number;
}> {
  const [config] = await db
    .select()
    .from(configsTable)
    .where(eq(configsTable.id, configId))
    .limit(1);

  if (!config) throw new Error("Config not found");
  const targets = getTargetsForExam(config.exam);

  let parsed = await parseFromReusableUnits(configId);
  if (!parsed) {
    let syllabusText = "";
    if (config.syllabusFileUrl) syllabusText = await extractSyllabusText(config);
    if (!syllabusText.trim()) {
      throw new Error("No reusable units selected and no syllabus uploaded");
    }
    parsed = await parseSyllabus(syllabusText, config.subject);
  }

  const catalog: SubtopicCatalogItem[] = [];
  for (const unit of parsed.units) {
    for (const topic of unit.topics) {
      for (const subtopic of topic.subtopics) {
        catalog.push({
          nodeId: "",
          unitTitle: unit.title,
          topicTitle: topic.title,
          subtopicTitle: subtopic,
          normUnit: normalizeText(unit.title),
          normTopic: normalizeText(topic.title),
          normSubtopic: normalizeText(subtopic),
        });
      }
    }
  }

  let paperText = "";
  const warnings: string[] = [];
  let extractionMethod: LaneAReplicaExtractionInfo["extractionMethod"] = "none";
  if (config.paperFileUrls && config.paperFileUrls.length > 0) {
    paperText = await extractPaperText(config.paperFileUrls.slice(0, 1));
    if (!paperText.trim()) {
      warnings.push("Replica file exists but text extraction returned empty content.");
    }
  }

  let replicaQuestions: GeneratedQuestion[] = [];
  if (paperText.trim()) {
    try {
      const extracted = await extractReplicaQuestions(paperText, catalog, config.subject);
      replicaQuestions = extracted.questions.filter((q) => isLikelyQuestionText(q.question));
      extractionMethod = extracted.method;
      if (extractionMethod === "heuristic") {
        warnings.push("Replica extraction used fallback heuristic mode. Please review mandatory replica questions before Lane B import.");
        if (extracted.modelError) {
          warnings.push(`AI extraction failure: ${extracted.modelError}`);
        }
      }
      if (replicaQuestions.length === 0) {
        warnings.push("No mandatory replica questions could be extracted from the uploaded replica.");
      }
    } catch (err) {
      logger.warn({ err, configId }, "Failed to extract replica questions for lane A package");
      warnings.push("Replica question extraction failed. Lane A continued without mandatory replica questions.");
    }
  } else if (config.paperFileUrls && config.paperFileUrls.length > 0) {
    warnings.push("Replica file is attached, but no readable text was detected.");
  }

  return {
    configId,
    subject: config.subject,
    structure: parsed.units,
    replicaQuestions: replicaQuestions.map((q) => ({
      markType: q.markType,
      question: q.question,
      answer: q.answer,
      unitTitle: q.unitTitle,
      topicTitle: q.topicTitle,
      subtopicTitle: q.subtopicTitle,
      isStarred: q.isStarred,
    })),
    warnings,
    replicaExtraction: {
      hasReplicaFile: Boolean(config.paperFileUrls && config.paperFileUrls.length > 0),
      extractedPaperTextLength: paperText.length,
      extractionMethod,
    },
    totalQuestionTarget: targets.totalQuestions,
    totalStarTarget: targets.totalStars,
  };
}

async function generateQuestionBatch(
  subject: string,
  catalog: SubtopicCatalogItem[],
  paperText: string,
  existingQuestions: string[],
  count: number,
  starCount: number,
  includeReplicaSeed: GeneratedQuestion[] = []
): Promise<GeneratedQuestion[]> {
  const catalogShort = catalog.slice(0, 180).map((c) => `${c.unitTitle} > ${c.topicTitle} > ${c.subtopicTitle}`);

  const prompt = `Generate ${count} exam questions for subject "${subject}".

Return ONLY valid JSON:
{
  "questions": [
    {
      "markType": "Foundational" | "Applied",
      "question": "...",
      "answer": "...",
      "unitTitle": "...",
      "topicTitle": "...",
      "subtopicTitle": "...",
      "isStarred": true | false,
      "origin": "pattern" | "generated"
    }
  ]
}

Rules:
- Mix pattern-based (from paper style) and syllabus-generated questions
- Keep answers concise: Foundational 25-55 words, Applied 60-110 words
- Make formatting clean with short bullets/steps where useful
- Use beginner-friendly English only (very simple words, short sentences)
- Avoid dense terms like "invocation context", "lexical binding", "introspection" unless explained in plain words
- Never return one dense paragraph answer.
- Foundational answers must be 2-4 short lines with clear line breaks and one tiny real-world example when it improves understanding.
- Applied answers must be 4-7 short lines with steps/bullets and optional mini example.
- Decide contextually:
  - If the subject/question is technical and code genuinely improves clarity, you may include a short fenced code block.
  - If the subject/question is non-technical, avoid code blocks and use short step-wise explanation with a tiny practical example.
- In this batch, exactly ${starCount} should have isStarred=true
- Avoid duplicates with these existing questions:
${existingQuestions.slice(0, 200).map((q) => `- ${q}`).join("\n") || "(none)"}
- Keep topic coverage broad and balanced
- Use only these syllabus paths:
${catalogShort.join("\n")}
${includeReplicaSeed.length > 0 ? `- You may adapt these replica seed questions (do not copy exactly):\n${includeReplicaSeed.map((q) => `  - ${q.question}`).join("\n")}` : ""}
${paperText ? `- Reference paper style context:\n${paperText.substring(0, 6000)}` : ""}`;

  let parsed: { questions?: Array<Partial<GeneratedQuestion>> };
  try {
    parsed = await askModelForJson<{ questions?: Array<Partial<GeneratedQuestion>> }>(
      "You generate strict JSON exam question banks with concise high-quality answers.",
      prompt,
      6200,
      "Question batch generation failed"
    );
  } catch (primaryErr) {
    logger.warn({ err: primaryErr, count }, "Primary question batch prompt failed; trying slim fallback prompt");
    const compactCatalog = catalog.slice(0, 60).map((c) => `${c.unitTitle} > ${c.topicTitle} > ${c.subtopicTitle}`);
    const slimPrompt = `Generate ${count} exam questions for "${subject}" and return STRICT JSON only.

Format:
{
  "questions": [
    {
      "markType": "Foundational" | "Applied",
      "question": "...",
      "answer": "...",
      "unitTitle": "...",
      "topicTitle": "...",
      "subtopicTitle": "...",
      "isStarred": true | false,
      "origin": "pattern" | "generated"
    }
  ]
}

Rules:
- Exactly ${count} questions.
- Exactly ${starCount} starred.
- Keep answers concise.
- Keep answers structured with line breaks (not a dense paragraph).
- Foundational: 2-4 short lines with one tiny real-world example when helpful.
- Applied: 4-7 short lines.
- Decide contextually:
  - If the subject/question is technical and code genuinely improves clarity, you may include a short fenced code block.
  - If the subject/question is non-technical, avoid code blocks and use short step-wise explanation with a tiny practical example.
- Use only these syllabus paths:
${compactCatalog.join("\n")}
- Avoid duplicates with:
${existingQuestions.slice(0, 40).map((q) => `- ${q}`).join("\n") || "(none)"}
`;

    parsed = await askModelForJson<{ questions?: Array<Partial<GeneratedQuestion>> }>(
      "Return one valid JSON object only.",
      slimPrompt,
      4200,
      "Question batch generation failed (fallback)"
    );
  }
  const questions = parsed.questions ?? [];

  return questions
    .filter((q) => q.question && q.answer && isLikelyQuestionText(String(q.question)))
    .slice(0, count)
    .map((q) => ({
      markType: q.markType === "Applied" ? "Applied" : "Foundational",
      question: String(q.question || "").trim(),
      answer: String(q.answer || "").trim(),
      unitTitle: String(q.unitTitle || "").trim(),
      topicTitle: String(q.topicTitle || "").trim(),
      subtopicTitle: String(q.subtopicTitle || "").trim(),
      isStarred: Boolean(q.isStarred),
      starSource: q.isStarred ? "auto" : "none",
      origin: q.origin === "pattern" ? "pattern" : "generated",
    }));
}

function dedupeQuestions(questions: GeneratedQuestion[]): GeneratedQuestion[] {
  const seen = new Set<string>();
  const out: GeneratedQuestion[] = [];
  for (const q of questions) {
    const key = normalizeText(q.question);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

function rebalanceStars(questions: GeneratedQuestion[], targetStars: number): GeneratedQuestion[] {
  const prioritized = [...questions].sort((a, b) => {
    const originRank = (o: QuestionOrigin) => (o === "replica" ? 0 : o === "pattern" ? 1 : 2);
    const markRank = (m: QuestionLevel) => (m === "Foundational" ? 0 : 1);
    return originRank(a.origin) - originRank(b.origin) || markRank(a.markType) - markRank(b.markType);
  });

  let stars = prioritized.filter((q) => q.isStarred).length;
  if (stars < targetStars) {
    for (const q of prioritized) {
      if (stars >= targetStars) break;
      if (!q.isStarred) {
        q.isStarred = true;
        q.starSource = "auto";
        stars += 1;
      }
    }
  } else if (stars > targetStars) {
    for (let i = prioritized.length - 1; i >= 0 && stars > targetStars; i--) {
      const q = prioritized[i];
      if (q.isStarred && q.origin !== "replica") {
        q.isStarred = false;
        q.starSource = "none";
        stars -= 1;
      }
    }
    for (let i = prioritized.length - 1; i >= 0 && stars > targetStars; i--) {
      const q = prioritized[i];
      if (q.isStarred) {
        q.isStarred = false;
        q.starSource = "none";
        stars -= 1;
      }
    }
  }

  return prioritized;
}

function pickBestSubtopicNode(question: GeneratedQuestion, catalog: SubtopicCatalogItem[]): string {
  if (catalog.length === 0) return "";

  const qUnit = normalizeText(question.unitTitle);
  const qTopic = normalizeText(question.topicTitle);
  const qSubtopic = normalizeText(question.subtopicTitle);
  const qText = normalizeText(question.question);

  let best = catalog[0];
  let bestScore = -1;

  for (const item of catalog) {
    let score = 0;
    if (qSubtopic && (item.normSubtopic.includes(qSubtopic) || qSubtopic.includes(item.normSubtopic))) score += 6;
    if (qTopic && (item.normTopic.includes(qTopic) || qTopic.includes(item.normTopic))) score += 4;
    if (qUnit && (item.normUnit.includes(qUnit) || qUnit.includes(item.normUnit))) score += 3;

    const subTokens = item.normSubtopic.split(" ").filter((t) => t.length > 3);
    for (const token of subTokens.slice(0, 5)) {
      if (qText.includes(token)) score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return best.nodeId;
}

async function buildQuestionBank(
  subject: string,
  catalog: SubtopicCatalogItem[],
  paperText: string,
  totalQuestions: number,
  totalStars: number
): Promise<GeneratedQuestion[]> {
  const TOTAL = totalQuestions;
  let STAR_TARGET = Math.min(totalStars, TOTAL);

  let replica: GeneratedQuestion[] = [];
  try {
    replica = (await extractReplicaQuestions(paperText, catalog, subject)).questions;
  } catch (err) {
    logger.warn({ err }, "Replica question extraction failed; continuing without replica questions");
  }
  if (replica.length === 0) {
    STAR_TARGET = 0;
  }
  let questions = dedupeQuestions(replica);

  let dynamicBatchSize = Math.max(QUESTION_MIN_BATCH_SIZE, QUESTION_BATCH_SIZE);
  const maxAttempts = 12;
  let attempts = 0;

  while (questions.length < TOTAL && attempts < maxAttempts) {
    attempts++;
    const remaining = TOTAL - questions.length;
    const count = Math.min(dynamicBatchSize, remaining);
    const starsRemaining = Math.max(0, STAR_TARGET - questions.filter((q) => q.isStarred).length);
    const starCount = Math.min(starsRemaining, count);

    try {
      const generated = await generateQuestionBatch(
        subject,
        catalog,
        paperText,
        questions.map((q) => q.question),
        count,
        starCount,
        attempts === 1 ? replica : []
      );

      const before = questions.length;
      questions = dedupeQuestions([...questions, ...generated]);
      const added = questions.length - before;

      if (added <= Math.floor(count / 3) && dynamicBatchSize > QUESTION_MIN_BATCH_SIZE) {
        dynamicBatchSize = Math.max(QUESTION_MIN_BATCH_SIZE, dynamicBatchSize - 2);
      }
    } catch (err) {
      logger.warn({ err, attempts, dynamicBatchSize }, "Question batch failed; shrinking batch and retrying");
      if (dynamicBatchSize > QUESTION_MIN_BATCH_SIZE) {
        dynamicBatchSize = Math.max(QUESTION_MIN_BATCH_SIZE, dynamicBatchSize - 2);
      }
    }
  }

  questions = questions.slice(0, TOTAL);
  questions = rebalanceStars(questions, STAR_TARGET);

  return questions;
}

export async function runGeneration(configId: string) {
  try {
    setProgress(configId, {
      configId,
      status: "parsing",
      progress: 0,
      total: 1,
      currentStep: "Fetching config...",
      error: null,
    });

    const [config] = await db
      .select()
      .from(configsTable)
      .where(eq(configsTable.id, configId))
      .limit(1);

    if (!config) throw new Error(`Config ${configId} not found`);
    const targets = getTargetsForExam(config.exam);

    let paperText = "";
    if (config.paperFileUrls && config.paperFileUrls.length > 0) {
      setProgress(configId, { currentStep: "Extracting replica paper text..." });
      paperText = await extractPaperText(config.paperFileUrls.slice(0, 1));
    }

    setProgress(configId, { currentStep: "Loading reusable unit structure..." });
    let parsed = await parseFromReusableUnits(configId);
    if (!parsed) {
      let syllabusText = "";
      if (config.syllabusFileUrl) {
        setProgress(configId, { currentStep: "Extracting syllabus text..." });
        syllabusText = await extractSyllabusText(config);
      }
      if (!syllabusText.trim()) {
        throw new Error("No reusable units selected and no syllabus uploaded");
      }

      setProgress(configId, { currentStep: "Parsing syllabus structure..." });
      parsed = await parseSyllabus(syllabusText, config.subject);
    }

    const existingNodes = await db
      .select({ id: nodesTable.id })
      .from(nodesTable)
      .where(eq(nodesTable.configId, configId));

    if (existingNodes.length > 0) {
      const nodeIds = existingNodes.map((n) => n.id);
      for (const nid of nodeIds) {
        await db.delete(subtopicQuestionsTable).where(eq(subtopicQuestionsTable.nodeId, nid));
        await db.delete(subtopicContentsTable).where(eq(subtopicContentsTable.nodeId, nid));
      }
      await db.delete(nodesTable).where(eq(nodesTable.configId, configId));
    }

    let totalSubtopics = 0;
    let totalTopics = 0;
    for (const unit of parsed.units) {
      for (const topic of unit.topics) {
        totalTopics += 1;
        totalSubtopics += topic.subtopics.length;
      }
    }

    const totalSteps = totalSubtopics + totalTopics + targets.totalQuestions;

    setProgress(configId, {
      status: "generating",
      progress: 0,
      total: totalSteps,
      currentStep: "Creating roadmap and explanations...",
    });

    let subtopicCount = 0;
    let topicCount = 0;
    const catalog: SubtopicCatalogItem[] = [];
    setProgress(configId, { currentStep: "Loading reusable explanations..." });
    const reusableExplanationMap = await loadReusableExplanationMap(config.subject, configId);
    const reusableTopicExplanationMap = await loadReusableTopicExplanationMap(config.subject, configId);

    for (let ui = 0; ui < parsed.units.length; ui++) {
      const unit = parsed.units[ui];
      const unitId = `${configId}_u${ui + 1}`;

      await db.insert(nodesTable).values({
        id: unitId,
        configId,
        title: unit.title,
        type: "unit",
        parentId: null,
        sortOrder: String(ui + 1),
      });

      for (let ti = 0; ti < unit.topics.length; ti++) {
        const topic = unit.topics[ti];
        const topicId = `${configId}_u${ui + 1}_t${ti + 1}`;
        const topicKey = topicExplanationKey(unit.title, topic.title);
        let topicExplanation = reusableTopicExplanationMap.get(topicKey) || "";
        if (!topicExplanation) {
          try {
            topicExplanation = await generateTopicExplanation(
              config.subject,
              unit.title,
              topic.title
            );
          } catch (err) {
            logger.warn({ err, topicTitle: topic.title }, "Failed to generate topic explanation");
            topicExplanation = "Topic summary will be updated soon.";
          }
        }

        await db.insert(nodesTable).values({
          id: topicId,
          configId,
          title: topic.title,
          type: "topic",
          parentId: unitId,
          explanation: repairBrokenFormulaBullets(topicExplanation),
          sortOrder: String(ti + 1),
        });
        topicCount++;

        for (let si = 0; si < topic.subtopics.length; si++) {
          const subtopicTitle = topic.subtopics[si];
          const subtopicId = `${configId}_u${ui + 1}_t${ti + 1}_s${si + 1}`;

          await db.insert(nodesTable).values({
            id: subtopicId,
            configId,
            title: subtopicTitle,
            type: "subtopic",
            parentId: topicId,
            sortOrder: String(si + 1),
          });

          catalog.push({
            nodeId: subtopicId,
            unitTitle: unit.title,
            topicTitle: topic.title,
            subtopicTitle,
            normUnit: normalizeText(unit.title),
            normTopic: normalizeText(topic.title),
            normSubtopic: normalizeText(subtopicTitle),
          });

          setProgress(configId, {
            progress: topicCount + subtopicCount,
            currentStep: `Writing explanation: ${subtopicTitle}`,
          });

          try {
            const reusedExplanation = reusableExplanationMap.get(
              explanationKey(unit.title, topic.title, subtopicTitle)
            );
            const explanation = reusedExplanation
              ? reusedExplanation
              : await generateSubtopicExplanation(
                  config.subject,
                  unit.title,
                  topic.title,
                  subtopicTitle,
                );

            const contentId = randomUUID();
            await db.insert(subtopicContentsTable).values({
              id: contentId,
              nodeId: subtopicId,
              explanation: repairBrokenFormulaBullets(explanation),
            });
          } catch (err) {
            logger.error({ err, subtopicTitle }, "Failed to generate explanation for subtopic");
            const contentId = randomUUID();
            await db.insert(subtopicContentsTable).values({
              id: contentId,
              nodeId: subtopicId,
              explanation: "Content will be updated soon.",
            });
          }

          subtopicCount++;
        }
      }
    }

    setProgress(configId, {
      progress: topicCount + subtopicCount,
      currentStep: `Generating ${targets.totalQuestions}-question bank...`,
    });

    const questionBank = await buildQuestionBank(
      config.subject,
      catalog,
      paperText,
      targets.totalQuestions,
      targets.totalStars
    );

    let insertedQuestions = 0;
    for (const q of questionBank) {
      const nodeId = pickBestSubtopicNode(q, catalog);
      if (!nodeId) continue;

      await db.insert(subtopicQuestionsTable).values({
        nodeId,
        markType: q.markType,
        question: q.question,
        answer: repairBrokenFormulaBullets(q.answer),
        isStarred: q.isStarred,
        starSource: q.isStarred ? "auto" : "none",
      });

      insertedQuestions++;
      setProgress(configId, {
        progress: topicCount + subtopicCount + insertedQuestions,
        currentStep: `Building question bank (${insertedQuestions}/${targets.totalQuestions})`
      });
    }

    setProgress(configId, {
      status: "complete",
      progress: topicCount + subtopicCount + insertedQuestions,
      total: totalSteps,
      currentStep: "Generation complete!",
    });

    logger.info({ configId, subtopicCount: totalSubtopics, questionCount: insertedQuestions }, "Generation complete");
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err, configId }, "Generation failed");
    setProgress(configId, {
      status: "error",
      currentStep: "Generation failed",
      error: errorMsg,
    });
  }
}

