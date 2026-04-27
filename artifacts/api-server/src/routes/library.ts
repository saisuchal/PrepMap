import { Router, type IRouter } from "express";
import {
  db,
  pool,
  subjectsTable,
  unitLibraryTable,
  configUnitLinksTable,
  configsTable,
  canonicalNodesTable,
  nodesTable,
} from "../db";
import { and, eq, inArray } from "drizzle-orm";
import { requireAdmin } from "../middleware/adminAuth";
import { createHash, randomUUID } from "crypto";
import { askAI } from "../lib/ai";
import { parseFirstModelJsonObject } from "../lib/parseModelJson";

const router: IRouter = Router();

type UnitTopicInput = {
  title: string;
  subtopics: string[];
};

type ExtractedFact = {
  factId: string;
  type: "definition" | "rule" | "note" | "pitfall" | "insight" | "example_candidate";
  text: string;
  sourceSpan: string;
};

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

function toSlug(value: string): string {
  const n = normalizeText(value);
  return n ? n.replace(/\s+/g, "_") : "untitled";
}

function legacyUnitTopicId(unitLibraryId: string, topicTitle: string): string {
  return `utp_${unitLibraryId}_${toSlug(topicTitle)}`;
}

function legacyUnitSubtopicId(unitTopicId: string, subtopicTitle: string): string {
  return `ust_${unitTopicId}_${toSlug(subtopicTitle)}`;
}

function sanitizeTopics(input: unknown): UnitTopicInput[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((t) => ({
      title: typeof (t as any)?.title === "string" ? (t as any).title.trim() : "",
      subtopics: Array.isArray((t as any)?.subtopics)
        ? (t as any).subtopics
            .filter((s: unknown) => typeof s === "string")
            .map((s: string) => s.trim())
            .filter(Boolean)
        : [],
    }))
    .filter((t) => t.title.length > 0);
}

function normalizeAndSanitizeTopics(input: unknown): UnitTopicInput[] {
  const sanitized = sanitizeTopics(input);
  return normalizeExtractedTopics(sanitized);
}

function finalizeGlanceableTitle(value: string): string {
  let t = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[,:;.\-_/]+$/g, "")
    .trim();

  // Remove trailing connector words that indicate an incomplete fragment.
  const trailingConnector = /\b(and|or|for|to|with|of|in|on|by|from|the|a|an)\b$/i;
  while (trailingConnector.test(t)) {
    t = t.replace(trailingConnector, "").trim();
  }

  return t;
}

function enforceMapLabelStyle(value: string, options?: { maxWords?: number }): string {
  const maxWords = Math.max(2, Number(options?.maxWords ?? 6));
  let t = finalizeGlanceableTitle(value);
  if (!t) return "";

  // Remove instruction-like prefixes; keep label noun-centric.
  t = t.replace(
    /^(using|use|implementing|implement|handling|handle|designing|design|tracking|track|enabling|enable|storing|store|sending|send|reading|read|returning|return|creating|create|initializing|initialize|setting up|setup)\s+/i,
    "",
  );

  // Prefer first compact segment when a sentence-like label leaks in.
  const segmentParts = t
    .split(/\s*[:;|]\s*|\s+[â€”-]\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (segmentParts.length > 1 && segmentParts[0].split(/\s+/).length >= 2) {
    t = segmentParts[0];
  }

  // If commas indicate explanation, keep the strongest first phrase.
  const commaParts = t.split(/\s*,\s*/).map((p) => p.trim()).filter(Boolean);
  if (commaParts.length > 1 && commaParts[0].split(/\s+/).length >= 2) {
    t = commaParts[0];
  }

  t = finalizeGlanceableTitle(t);
  if (!t) return "";

  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > maxWords) {
    // Soft cap only after semantic cleanup.
    t = words.slice(0, maxWords).join(" ");
  }

  t = finalizeGlanceableTitle(t);
  return t;
}

function makeCleanupGlanceableTopics(input: unknown): UnitTopicInput[] {
  const normalized = normalizeAndSanitizeTopics(input);
  const seenTopicKeys = new Set<string>();
  const output: UnitTopicInput[] = [];

  for (const topic of normalized) {
    const compactTopic = enforceMapLabelStyle(compactTopicTitle(topic.title), { maxWords: 6 });
    if (!compactTopic) continue;
    const topicKey = normalizeText(compactTopic);
    if (!topicKey || seenTopicKeys.has(topicKey)) continue;
    seenTopicKeys.add(topicKey);

    const seenSubtopicKeys = new Set<string>();
    const compactSubtopics = (topic.subtopics ?? [])
      .map((subtopic) => enforceMapLabelStyle(compactSubtopicTitle(subtopic), { maxWords: 5 }))
      .filter((subtopic) => {
        if (!subtopic) return false;
        const key = normalizeText(subtopic);
        if (!key || seenSubtopicKeys.has(key)) return false;
        seenSubtopicKeys.add(key);
        return true;
      });

    if (compactSubtopics.length === 0) continue;
    output.push({
      title: compactTopic,
      subtopics: compactSubtopics,
    });
  }

  return output;
}

function cleanGeneratedHeading(raw: unknown): string {
  return String(raw || "")
    .replace(/^\s*\d+(\.\d+)*\s*[-.)]?\s*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.:;,\-–—\s]+$/g, "")
    .trim();
}

function compactTopicTitle(raw: unknown): string {
  let t = cleanGeneratedHeading(raw)
    .replace(/^third\s+party\s+package\s*[-:]\s*/i, "")
    .replace(/^topic\s*[-:]\s*/i, "")
    .trim();
  // If the model returns list-like titles, keep only the first glanceable segment.
  t = t.split(/\s*[,;|]\s*/)[0] || t;
  // Keep "A - B" or "A — B" only when RHS stays compact.
  const dashMatch = t.match(/^(.*?)\s*[—-]\s*(.*)$/);
  if (dashMatch) {
    const lhs = dashMatch[1].trim();
    const rhs = dashMatch[2].trim();
    if (rhs.split(/\s+/).length > 4) t = lhs;
  }
  // Remove formula-heavy parenthetical parts from headings.
  t = t.replace(/\([^)]*(?:>=|<=|==|!=|arr\[|mid|low|high|o\()[^)]*\)/gi, "").trim();
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function compactSubtopicTitle(raw: unknown): string {
  let t = cleanGeneratedHeading(raw)
    .replace(/^subtopic\s*[-:]\s*/i, "")
    .split(/\s*[,;|]\s*/)[0] || cleanGeneratedHeading(raw);

  // Convert equation-style condition snippets into a readable label.
  t = t
    .replace(
      /\b(?:condition|check|rule)\s+arr\s*\[[^\]]+\]\s*(?:>=|<=|==|!=|>|<)\s*[a-z0-9_]+/gi,
      "Condition check",
    )
    .replace(
      /\barr\s*\[[^\]]+\]\s*(?:>=|<=|==|!=|>|<)\s*[a-z0-9_]+/gi,
      "Condition check",
    );

  // Remove formula-heavy parenthetical parts from headings.
  t = t.replace(/\([^)]*(?:>=|<=|==|!=|arr\[|mid|low|high|o\()[^)]*\)/gi, "");
  t = t.replace(/\s+/g, " ").trim();

  // Keep subtopic labels compact for map readability.
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 6) t = words.slice(0, 6).join(" ");
  return t
    .trim();
}

function compactFactText(raw: unknown): string {
  let t = String(raw || "")
    .replace(/^\s*[-*?]\s*/gm, "")
    .replace(/\brequest\.\s*json\b/gi, "request.json")
    .replace(/\.\s*env\b/gi, ".env")
    .replace(/\bos\.\s*getenv\b/gi, "os.getenv")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  const sentenceParts = t.match(/[^.!?]+[.!?]?/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  if (sentenceParts.length > 2) t = sentenceParts.slice(0, 2).join(" ");
  if (t.length > 220) {
    const cut = t.slice(0, 220);
    const lastBoundary = Math.max(cut.lastIndexOf("."), cut.lastIndexOf(";"), cut.lastIndexOf(","));
    t = `${(lastBoundary > 120 ? cut.slice(0, lastBoundary) : cut).trim()}.`;
  }
  return t.trim();
}
function canonicalizeFactText(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tokenJaccard(a: string, b: string): number {
  const aSet = new Set(canonicalizeFactText(a).split(" ").filter(Boolean));
  const bSet = new Set(canonicalizeFactText(b).split(" ").filter(Boolean));
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let inter = 0;
  for (const token of aSet) {
    if (bSet.has(token)) inter += 1;
  }
  const union = aSet.size + bSet.size - inter;
  return union > 0 ? inter / union : 0;
}
function isNearDuplicateFactText(a: string, b: string): boolean {
  const ca = canonicalizeFactText(a);
  const cb = canonicalizeFactText(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  if (ca.length >= 40 && cb.length >= 40 && (ca.includes(cb) || cb.includes(ca))) return true;
  return tokenJaccard(ca, cb) >= 0.88;
}
const FACT_FAITHFULNESS_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "from", "by",
  "is", "are", "was", "were", "be", "as", "it", "that", "this", "these", "those",
  "you", "your", "we", "our", "they", "their", "at", "into", "over", "under", "via",
  "can", "should", "must", "will", "would", "may", "might", "not",
]);
function passesFaithfulnessCheck(factText: string, sourceSpan: string, sourceText: string): boolean {
  const src = canonicalizeFactText(sourceText);
  if (!src) return false;
  const span = canonicalizeFactText(sourceSpan);
  if (span && src.includes(span)) return true;
  const keywords = canonicalizeFactText(factText)
    .split(" ")
    .filter((token) => token.length >= 4 && !FACT_FAITHFULNESS_STOPWORDS.has(token));
  if (keywords.length === 0) return false;
  let hits = 0;
  for (const kw of keywords) {
    if (src.includes(kw)) hits += 1;
    if (hits >= 2) return true;
  }
  return false;
}

function splitInlineOutlineFromTopicTitle(rawTopicTitle: string): { topicTitle: string; inlineSubtopics: string[] } {
  const cleaned = String(rawTopicTitle || "").trim();
  const colonIndex = cleaned.indexOf(":");
  if (colonIndex <= 0) return { topicTitle: cleaned, inlineSubtopics: [] };

  const lhs = cleaned.slice(0, colonIndex).trim();
  const rhs = cleaned.slice(colonIndex + 1).trim();
  if (!lhs || !rhs) return { topicTitle: cleaned, inlineSubtopics: [] };

  const parts = rhs
    .split(/\s*,\s*/)
    .map((p) => p.trim())
    .filter(Boolean);

  // Treat as outline dump only when we clearly have a list.
  if (parts.length < 2) return { topicTitle: cleaned, inlineSubtopics: [] };

  return { topicTitle: lhs, inlineSubtopics: parts };
}

function normalizeExtractedTopics(rawTopics: Array<{ title?: string; subtopics?: string[] }>): UnitTopicInput[] {
  const mergedByTopic = new Map<string, UnitTopicInput>();

  for (const raw of rawTopics ?? []) {
    const originalTitle = String(raw?.title || "").trim();
    const { topicTitle: splitTopicTitle, inlineSubtopics } = splitInlineOutlineFromTopicTitle(originalTitle);
    const title = compactTopicTitle(splitTopicTitle);
    if (!title) continue;

    const allSubtopicsRaw = [...inlineSubtopics, ...(Array.isArray(raw?.subtopics) ? raw.subtopics : [])];
    const seenSub = new Set<string>();
    const subtopics = allSubtopicsRaw
      .map((s) => compactSubtopicTitle(s))
      .filter((s) => {
        if (!s) return false;
        const k = normalizeText(s);
        if (!k || seenSub.has(k)) return false;
        seenSub.add(k);
        return true;
      });

    const topicKey = normalizeText(title);
    const existing = mergedByTopic.get(topicKey);
    if (!existing) {
      mergedByTopic.set(topicKey, { title, subtopics });
      continue;
    }

    const existingSet = new Set(existing.subtopics.map((s) => normalizeText(s)));
    for (const sub of subtopics) {
      const k = normalizeText(sub);
      if (!k || existingSet.has(k)) continue;
      existingSet.add(k);
      existing.subtopics.push(sub);
    }
  }

  return Array.from(mergedByTopic.values());
}

async function materializeConfigNodesFromSelectedUnits(
  tx: any,
  configId: string,
  subjectId: string,
  unitIds: string[],
): Promise<void> {
  if (unitIds.length === 0) return;
  await materializeConfigNodesFromSelectedUnitsCanonical(tx, configId, subjectId, unitIds);
  return;
}
async function materializeConfigNodesFromSelectedUnitsCanonical(
  tx: any,
  configId: string,
  subjectId: string,
  unitIds: string[],
): Promise<void> {
  type UnitRow = {
    id: string;
    unitTitle: string;
    topics: unknown;
  };
  type CanonicalRow = {
    id: string;
    unitLibraryId: string;
    title: string;
    type: string;
    parentCanonicalNodeId: string | null;
    explanation: string | null;
    learningGoal: string | null;
    exampleBlock: string | null;
    supportNote: string | null;
    prerequisiteTitles: string[] | null;
    prerequisiteNodeIds: string[] | null;
    nextRecommendedTitles: string[] | null;
    nextRecommendedNodeIds: string[] | null;
  };

  const units = (await tx
    .select({
      id: unitLibraryTable.id,
      unitTitle: unitLibraryTable.unitTitle,
      topics: unitLibraryTable.topics,
    })
    .from(unitLibraryTable)
    .where(inArray(unitLibraryTable.id, unitIds))) as UnitRow[];
  const unitById = new Map(units.map((u) => [u.id, u]));
  const orderedUnits = unitIds.map((id) => unitById.get(id)).filter((u): u is UnitRow => !!u);

  const existingCanonicalRows = (await tx
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
      prerequisiteTitles: canonicalNodesTable.prerequisiteTitles,
      prerequisiteNodeIds: canonicalNodesTable.prerequisiteNodeIds,
      nextRecommendedTitles: canonicalNodesTable.nextRecommendedTitles,
      nextRecommendedNodeIds: canonicalNodesTable.nextRecommendedNodeIds,
    })
    .from(canonicalNodesTable)
    .where(inArray(canonicalNodesTable.unitLibraryId, unitIds))) as CanonicalRow[];

  const existingById = new Map(existingCanonicalRows.map((r) => [r.id, r]));
  const existingTopicByKey = new Map<string, CanonicalRow>();
  const existingSubtopicByKey = new Map<string, CanonicalRow>();
  for (const row of existingCanonicalRows) {
    if (row.type === "topic") {
      existingTopicByKey.set(`${row.unitLibraryId}|${normalizeText(row.title)}`, row);
      continue;
    }
    if (row.type === "subtopic") {
      const parent = row.parentCanonicalNodeId ? existingById.get(row.parentCanonicalNodeId) ?? null : null;
      if (!parent || parent.type !== "topic") continue;
      existingSubtopicByKey.set(
        `${row.unitLibraryId}|${normalizeText(parent.title)}|${normalizeText(row.title)}`,
        row,
      );
    }
  }

  for (let ui = 0; ui < orderedUnits.length; ui++) {
    const unit = orderedUnits[ui];
    const desiredTopics = sanitizeTopics(unit.topics);
    const canonUnitId = canonicalUnitId(subjectId, unit.unitTitle);
    const scopedUnitId = scopedNodeId(configId, canonUnitId);

    await tx
      .insert(canonicalNodesTable)
      .values({
        id: canonUnitId,
        subjectId,
        unitLibraryId: unit.id,
        title: unit.unitTitle,
        normalizedTitle: normalizeText(unit.unitTitle),
        type: "unit",
        parentCanonicalNodeId: null,
        sortOrder: ui + 1,
      })
      .onConflictDoUpdate({
        target: [canonicalNodesTable.id],
        set: {
          title: unit.unitTitle,
          normalizedTitle: normalizeText(unit.unitTitle),
          unitLibraryId: unit.id,
          sortOrder: ui + 1,
          updatedAt: new Date(),
        },
      });

    await tx
      .insert(nodesTable)
      .values({
        id: scopedUnitId,
        configId,
        canonicalNodeId: canonUnitId,
        subjectId,
        unitLibraryId: unit.id,
        title: unit.unitTitle,
        normalizedTitle: normalizeText(unit.unitTitle),
        type: "unit",
        parentId: null,
        sortOrder: ui + 1,
      })
      .onConflictDoUpdate({
        target: [nodesTable.id],
        set: {
          title: unit.unitTitle,
          normalizedTitle: normalizeText(unit.unitTitle),
          unitLibraryId: unit.id,
          sortOrder: ui + 1,
          updatedAt: new Date(),
        },
      });

    for (let ti = 0; ti < desiredTopics.length; ti++) {
      const topic = desiredTopics[ti];
      const topicCanonicalId = canonicalTopicId(subjectId, unit.unitTitle, topic.title);
      const topicNodeId = scopedNodeId(configId, topicCanonicalId);
      const existingTopic = existingTopicByKey.get(`${unit.id}|${normalizeText(topic.title)}`);

      await tx
        .insert(canonicalNodesTable)
        .values({
          id: topicCanonicalId,
          subjectId,
          unitLibraryId: unit.id,
          title: topic.title,
          normalizedTitle: normalizeText(topic.title),
          type: "topic",
          parentCanonicalNodeId: canonUnitId,
          explanation: existingTopic?.explanation ?? null,
          learningGoal: existingTopic?.learningGoal ?? null,
          exampleBlock: existingTopic?.exampleBlock ?? null,
          supportNote: existingTopic?.supportNote ?? null,
          prerequisiteTitles: existingTopic?.prerequisiteTitles ?? null,
          prerequisiteNodeIds: existingTopic?.prerequisiteNodeIds ?? null,
          nextRecommendedTitles: existingTopic?.nextRecommendedTitles ?? null,
          nextRecommendedNodeIds: existingTopic?.nextRecommendedNodeIds ?? null,
          sortOrder: ti + 1,
        })
        .onConflictDoUpdate({
          target: [canonicalNodesTable.id],
          set: {
            title: topic.title,
            normalizedTitle: normalizeText(topic.title),
            parentCanonicalNodeId: canonUnitId,
            unitLibraryId: unit.id,
            explanation: existingTopic?.explanation ?? null,
            learningGoal: existingTopic?.learningGoal ?? null,
            exampleBlock: existingTopic?.exampleBlock ?? null,
            supportNote: existingTopic?.supportNote ?? null,
            prerequisiteTitles: existingTopic?.prerequisiteTitles ?? null,
            prerequisiteNodeIds: existingTopic?.prerequisiteNodeIds ?? null,
            nextRecommendedTitles: existingTopic?.nextRecommendedTitles ?? null,
            nextRecommendedNodeIds: existingTopic?.nextRecommendedNodeIds ?? null,
            sortOrder: ti + 1,
            updatedAt: new Date(),
          },
        });

      await tx
        .insert(nodesTable)
        .values({
          id: topicNodeId,
          configId,
          canonicalNodeId: topicCanonicalId,
          subjectId,
          unitLibraryId: unit.id,
          unitTopicId: topicCanonicalId,
          title: topic.title,
          normalizedTitle: normalizeText(topic.title),
          type: "topic",
          parentId: scopedUnitId,
          explanation: existingTopic?.explanation ?? null,
          learningGoal: existingTopic?.learningGoal ?? null,
          exampleBlock: existingTopic?.exampleBlock ?? null,
          supportNote: existingTopic?.supportNote ?? null,
          prerequisiteTitles: existingTopic?.prerequisiteTitles ?? null,
          prerequisiteNodeIds: existingTopic?.prerequisiteNodeIds ?? null,
          nextRecommendedTitles: existingTopic?.nextRecommendedTitles ?? null,
          nextRecommendedNodeIds: existingTopic?.nextRecommendedNodeIds ?? null,
          sortOrder: ti + 1,
        })
        .onConflictDoUpdate({
          target: [nodesTable.id],
          set: {
            title: topic.title,
            normalizedTitle: normalizeText(topic.title),
            parentId: scopedUnitId,
            explanation: existingTopic?.explanation ?? null,
            learningGoal: existingTopic?.learningGoal ?? null,
            exampleBlock: existingTopic?.exampleBlock ?? null,
            supportNote: existingTopic?.supportNote ?? null,
            prerequisiteTitles: existingTopic?.prerequisiteTitles ?? null,
            prerequisiteNodeIds: existingTopic?.prerequisiteNodeIds ?? null,
            nextRecommendedTitles: existingTopic?.nextRecommendedTitles ?? null,
            nextRecommendedNodeIds: existingTopic?.nextRecommendedNodeIds ?? null,
            sortOrder: ti + 1,
            updatedAt: new Date(),
          },
        });

      for (let si = 0; si < topic.subtopics.length; si++) {
        const subtopicTitle = topic.subtopics[si];
        const subtopicCanonicalId = canonicalSubtopicId(subjectId, unit.unitTitle, topic.title, subtopicTitle);
        const subtopicNodeId = scopedNodeId(configId, subtopicCanonicalId);
        const existingSubtopic = existingSubtopicByKey.get(
          `${unit.id}|${normalizeText(topic.title)}|${normalizeText(subtopicTitle)}`,
        );

        await tx
          .insert(canonicalNodesTable)
          .values({
            id: subtopicCanonicalId,
            subjectId,
            unitLibraryId: unit.id,
            title: subtopicTitle,
            normalizedTitle: normalizeText(subtopicTitle),
            type: "subtopic",
            parentCanonicalNodeId: topicCanonicalId,
            explanation: existingSubtopic?.explanation ?? null,
            learningGoal: existingSubtopic?.learningGoal ?? null,
            exampleBlock: existingSubtopic?.exampleBlock ?? null,
            supportNote: existingSubtopic?.supportNote ?? null,
            prerequisiteTitles: existingSubtopic?.prerequisiteTitles ?? null,
            prerequisiteNodeIds: existingSubtopic?.prerequisiteNodeIds ?? null,
            nextRecommendedTitles: existingSubtopic?.nextRecommendedTitles ?? null,
            nextRecommendedNodeIds: existingSubtopic?.nextRecommendedNodeIds ?? null,
            sortOrder: si + 1,
          })
          .onConflictDoUpdate({
            target: [canonicalNodesTable.id],
            set: {
              title: subtopicTitle,
              normalizedTitle: normalizeText(subtopicTitle),
              unitLibraryId: unit.id,
              parentCanonicalNodeId: topicCanonicalId,
              explanation: existingSubtopic?.explanation ?? null,
              learningGoal: existingSubtopic?.learningGoal ?? null,
              exampleBlock: existingSubtopic?.exampleBlock ?? null,
              supportNote: existingSubtopic?.supportNote ?? null,
              prerequisiteTitles: existingSubtopic?.prerequisiteTitles ?? null,
              prerequisiteNodeIds: existingSubtopic?.prerequisiteNodeIds ?? null,
              nextRecommendedTitles: existingSubtopic?.nextRecommendedTitles ?? null,
              nextRecommendedNodeIds: existingSubtopic?.nextRecommendedNodeIds ?? null,
              sortOrder: si + 1,
              updatedAt: new Date(),
            },
          });

        await tx
          .insert(nodesTable)
          .values({
            id: subtopicNodeId,
            configId,
            canonicalNodeId: subtopicCanonicalId,
            subjectId,
            unitLibraryId: unit.id,
            unitTopicId: topicCanonicalId,
            unitSubtopicId: subtopicCanonicalId,
            title: subtopicTitle,
            normalizedTitle: normalizeText(subtopicTitle),
            type: "subtopic",
            parentId: topicNodeId,
            explanation: existingSubtopic?.explanation ?? null,
            learningGoal: existingSubtopic?.learningGoal ?? null,
            exampleBlock: existingSubtopic?.exampleBlock ?? null,
            supportNote: existingSubtopic?.supportNote ?? null,
            prerequisiteTitles: existingSubtopic?.prerequisiteTitles ?? null,
            prerequisiteNodeIds: existingSubtopic?.prerequisiteNodeIds ?? null,
            nextRecommendedTitles: existingSubtopic?.nextRecommendedTitles ?? null,
            nextRecommendedNodeIds: existingSubtopic?.nextRecommendedNodeIds ?? null,
            sortOrder: si + 1,
          })
          .onConflictDoUpdate({
            target: [nodesTable.id],
            set: {
              title: subtopicTitle,
              normalizedTitle: normalizeText(subtopicTitle),
              parentId: topicNodeId,
              explanation: existingSubtopic?.explanation ?? null,
              learningGoal: existingSubtopic?.learningGoal ?? null,
              exampleBlock: existingSubtopic?.exampleBlock ?? null,
              supportNote: existingSubtopic?.supportNote ?? null,
              prerequisiteTitles: existingSubtopic?.prerequisiteTitles ?? null,
              prerequisiteNodeIds: existingSubtopic?.prerequisiteNodeIds ?? null,
              nextRecommendedTitles: existingSubtopic?.nextRecommendedTitles ?? null,
              nextRecommendedNodeIds: existingSubtopic?.nextRecommendedNodeIds ?? null,
              sortOrder: si + 1,
              updatedAt: new Date(),
            },
          });
      }
    }
  }
}

async function loadUnitFactCountsFromUnitFacts(unitIds: string[]): Promise<Map<string, number> | null> {
  if (unitIds.length === 0) return new Map();

  const exists = await pool.query<{ regclass: string | null }>(
    `SELECT to_regclass('public.unit_facts') AS regclass`,
  );
  if (!exists.rows[0]?.regclass) return null;

  const columns = await pool.query<{ column_name: string }>(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'unit_facts'
    `,
  );
  const colSet = new Set(columns.rows.map((r) => String(r.column_name || "").trim().toLowerCase()));
  const unitCol = ["unit_library_id", "unit_id", "library_unit_id"].find((c) => colSet.has(c));
  if (!unitCol) return null;

  const factTextCol = ["fact_text", "text", "fact", "content"].find((c) => colSet.has(c));
  const whereFact = factTextCol ? `AND COALESCE(BTRIM(CAST(uf.${factTextCol} AS text)), '') <> ''` : "";

  const sqlText = `
    SELECT CAST(uf.${unitCol} AS text) AS unit_id, COUNT(*)::int AS fact_count
    FROM public.unit_facts uf
    WHERE CAST(uf.${unitCol} AS text) = ANY($1::text[])
    ${whereFact}
    GROUP BY CAST(uf.${unitCol} AS text)
  `;
  const result = await pool.query<{ unit_id: string; fact_count: number }>(sqlText, [unitIds]);
  return new Map(result.rows.map((r) => [String(r.unit_id), Number(r.fact_count) || 0]));
}

async function saveFactsToUnitFacts(
  unitLibraryId: string,
  topics: UnitTopicInput[],
  topicFacts: Map<string, ExtractedFact[]>,
  subtopicFacts: Map<string, ExtractedFact[]>,
): Promise<void> {
  const exists = await pool.query<{ regclass: string | null }>(
    `SELECT to_regclass('public.unit_facts') AS regclass`,
  );
  if (!exists.rows[0]?.regclass) return;

  const columns = await pool.query<{ column_name: string }>(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'unit_facts'
    `,
  );
  const colSet = new Set(columns.rows.map((r) => String(r.column_name || "").trim().toLowerCase()));
  const unitCol = ["unit_library_id", "unit_id", "library_unit_id"].find((c) => colSet.has(c));
  const topicCol = ["topic_title", "topic", "topic_name"].find((c) => colSet.has(c));
  const subtopicCol = ["subtopic_title", "subtopic", "subtopic_name"].find((c) => colSet.has(c));
  const topicIdCol = ["unit_topic_id", "topic_id"].find((c) => colSet.has(c));
  const subtopicIdCol = ["unit_subtopic_id", "subtopic_id"].find((c) => colSet.has(c));
  const factTextCol = ["fact_text", "text", "fact", "content"].find((c) => colSet.has(c));
  const factTypeCol = ["fact_type", "type"].find((c) => colSet.has(c));
  const factIdCol = ["fact_id", "id"].find((c) => colSet.has(c));
  const levelCol = colSet.has("level") ? "level" : null;
  const sortOrderCol = colSet.has("sort_order") ? "sort_order" : null;
  const sourceCol = ["source_span", "source", "source_text", "source_ref"].find((c) => colSet.has(c));
  const createdAtCol = colSet.has("created_at") ? "created_at" : null;
  const updatedAtCol = colSet.has("updated_at") ? "updated_at" : null;

  if (!unitCol || !factTextCol) return;

  await pool.query(`DELETE FROM public.unit_facts WHERE CAST(${unitCol} AS text) = $1`, [unitLibraryId]);

  const rows: Array<{
    topicTitle: string;
    subtopicTitle: string;
    unitTopicId: string;
    unitSubtopicId: string;
    factText: string;
    factType: string;
    factId: string;
    sourceSpan: string;
  }> = [];
  for (const topic of topics) {
    const topicTitle = String(topic.title || "").trim();
    if (!topicTitle) continue;
    const topicKey = normalizeText(topicTitle);
    const unitTopicId = legacyUnitTopicId(unitLibraryId, topicTitle);
    for (const fact of topicFacts.get(topicKey) ?? []) {
      const text = String(fact?.text || "").trim();
      if (!text) continue;
      rows.push({
        topicTitle,
        subtopicTitle: "",
        unitTopicId,
        unitSubtopicId: "",
        factText: text,
        factType: String(fact?.type || "note"),
        factId: String(fact?.factId || "").trim(),
        sourceSpan: String(fact?.sourceSpan || "").trim(),
      });
    }

    for (const subtopicRaw of topic.subtopics ?? []) {
      const subtopicTitle = String(subtopicRaw || "").trim();
      if (!subtopicTitle) continue;
      const unitSubtopicId = legacyUnitSubtopicId(unitTopicId, subtopicTitle);
      const factsKey = `${topicKey}|${normalizeText(subtopicTitle)}`;
      for (const fact of subtopicFacts.get(factsKey) ?? []) {
        const text = String(fact?.text || "").trim();
        if (!text) continue;
        rows.push({
          topicTitle,
          subtopicTitle,
          unitTopicId,
          unitSubtopicId,
          factText: text,
          factType: String(fact?.type || "note"),
          factId: String(fact?.factId || "").trim(),
          sourceSpan: String(fact?.sourceSpan || "").trim(),
        });
      }
    }
  }

  if (rows.length === 0) return;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    const columnsSql: string[] = [unitCol];
    const valuesSql: string[] = ["$1"];
    const values: unknown[] = [unitLibraryId];
    let index = 2;

    if (topicCol) {
      columnsSql.push(topicCol);
      valuesSql.push(`$${index++}`);
      values.push(row.topicTitle);
    }
    if (subtopicCol) {
      columnsSql.push(subtopicCol);
      valuesSql.push(`$${index++}`);
      values.push(row.subtopicTitle || null);
    }
    if (topicIdCol) {
      columnsSql.push(topicIdCol);
      valuesSql.push(`$${index++}`);
      values.push(row.unitTopicId || null);
    }
    if (subtopicIdCol) {
      columnsSql.push(subtopicIdCol);
      valuesSql.push(`$${index++}`);
      values.push(row.unitSubtopicId || null);
    }
    columnsSql.push(factTextCol);
    valuesSql.push(`$${index++}`);
    values.push(row.factText);
    if (factTypeCol) {
      columnsSql.push(factTypeCol);
      valuesSql.push(`$${index++}`);
      values.push(row.factType);
    }
    if (levelCol) {
      columnsSql.push(levelCol);
      valuesSql.push(`$${index++}`);
      values.push(row.subtopicTitle ? "subtopic" : "topic");
    }
    if (factIdCol) {
      columnsSql.push(factIdCol);
      valuesSql.push(`$${index++}`);
      if (factIdCol === "id") {
        values.push(randomUUID());
      } else {
        values.push(row.factId || `uf_${randomUUID().slice(0, 8)}`);
      }
    }
    if (sortOrderCol) {
      columnsSql.push(sortOrderCol);
      valuesSql.push(`$${index++}`);
      values.push(rowIndex + 1);
    }
    if (sourceCol) {
      columnsSql.push(sourceCol);
      valuesSql.push(`$${index++}`);
      values.push(row.sourceSpan || "");
    }
    if (createdAtCol) {
      columnsSql.push(createdAtCol);
      valuesSql.push("NOW()");
    }
    if (updatedAtCol) {
      columnsSql.push(updatedAtCol);
      valuesSql.push("NOW()");
    }

    const sql = `INSERT INTO public.unit_facts (${columnsSql.join(", ")}) VALUES (${valuesSql.join(", ")})`;
    await pool.query(sql, values);
  }
}

type BatchMaterialInput = {
  materialId: string;
  explicitTitle: string | null;
  titleHint: string;
  readingText: string;
};

function createFallbackUnitTitle(): string {
  return `unit-${Math.floor(10000 + Math.random() * 90000)}`;
}

type ExtractedMaterialStructure = {
  unitTitle: string;
  topics: UnitTopicInput[];
};

async function extractFactsForMaterial(
  subjectName: string,
  unitTitle: string,
  topics: UnitTopicInput[],
  readingText: string,
): Promise<{
  topicFacts: Map<string, ExtractedFact[]>;
  subtopicFacts: Map<string, ExtractedFact[]>;
}> {
  const trimmedText = String(readingText || "").trim().slice(0, 9000);
  if (!trimmedText) return { topicFacts: new Map(), subtopicFacts: new Map() };
  const allow = new Set(["definition", "rule", "note", "pitfall", "insight", "example_candidate"]);
  const topicFacts = new Map<string, ExtractedFact[]>();
  const subtopicFacts = new Map<string, ExtractedFact[]>();

  const pushUniqueFact = (target: Map<string, ExtractedFact[]>, key: string, facts: ExtractedFact[]) => {
    const existing = target.get(key) ?? [];
    for (const fact of facts) {
      if (!fact.text) continue;
      if (!String(fact.sourceSpan || "").trim()) continue;
      if (!passesFaithfulnessCheck(fact.text, fact.sourceSpan, trimmedText)) continue;
      const duplicate = existing.some((f) => f.type === fact.type && isNearDuplicateFactText(f.text, fact.text));
      if (duplicate) continue;
      existing.push(fact);
    }
    target.set(key, existing);
  };

  const parseFactsRows = (
    parsed: {
      topicFacts?: Array<{ topicTitle?: string; facts?: ExtractedFact[] }>;
      subtopicFacts?: Array<{ topicTitle?: string; subtopicTitle?: string; facts?: ExtractedFact[] }>;
    },
    chunkTopics: UnitTopicInput[],
  ) => {
    const normTopicSet = new Set(chunkTopics.map((t) => normalizeText(t.title)));
    const normSubtopicSet = new Set(
      chunkTopics.flatMap((t) => t.subtopics.map((s) => `${normalizeText(t.title)}|${normalizeText(s)}`))
    );

    for (const row of parsed.topicFacts ?? []) {
      const topicTitle = String(row?.topicTitle || "").trim();
      const normTopic = normalizeText(topicTitle);
      if (!normTopic || !normTopicSet.has(normTopic)) continue;
      const facts = (Array.isArray(row?.facts) ? row.facts : [])
        .map((f) => ({
          factId: String(f?.factId || `uf_${randomUUID().slice(0, 8)}`).trim(),
          type: allow.has(String(f?.type || "").trim())
            ? (String(f?.type || "").trim() as ExtractedFact["type"])
            : "note",
          text: compactFactText(f?.text),
          sourceSpan: String(f?.sourceSpan || "").trim(),
        }))
        .filter((f) => f.text);
      pushUniqueFact(topicFacts, normTopic, facts);
    }

    for (const row of parsed.subtopicFacts ?? []) {
      const topicTitle = String(row?.topicTitle || "").trim();
      const subtopicTitle = String(row?.subtopicTitle || "").trim();
      const key = `${normalizeText(topicTitle)}|${normalizeText(subtopicTitle)}`;
      if (!normSubtopicSet.has(key)) continue;
      const facts = (Array.isArray(row?.facts) ? row.facts : [])
        .map((f) => ({
          factId: String(f?.factId || `uf_${randomUUID().slice(0, 8)}`).trim(),
          type: allow.has(String(f?.type || "").trim())
            ? (String(f?.type || "").trim() as ExtractedFact["type"])
            : "note",
          text: compactFactText(f?.text),
          sourceSpan: String(f?.sourceSpan || "").trim(),
        }))
        .filter((f) => f.text);
      pushUniqueFact(subtopicFacts, key, facts);
    }
  };

  const extractChunk = async (chunkTopics: UnitTopicInput[]) => {
    const basePrompt = `You are extracting factual grounding atoms for exam-prep generation.

Subject: ${subjectName}
Unit: ${unitTitle}

Return ONLY valid JSON:
{
  "topicFacts": [
    {
      "topicTitle": "exact topic title from provided list",
      "facts": [
        { "factId": "auto-id", "type": "definition|rule|note|pitfall|insight|example_candidate", "text": "...", "sourceSpan": "short source pointer" }
      ]
    }
  ],
  "subtopicFacts": [
    {
      "topicTitle": "exact topic title from provided list",
      "subtopicTitle": "exact subtopic title from provided list",
      "facts": [
        { "factId": "auto-id", "type": "definition|rule|note|pitfall|insight|example_candidate", "text": "...", "sourceSpan": "short source pointer" }
      ]
    }
  ]
}

Rules:
- The first character of your response must be { and the last must be }.
- No markdown fences, no prose, no explanation outside JSON.
- Use only topic/subtopic titles provided below (exact match).
- 1 to 3 short, high-signal facts per topic/subtopic whenever source supports it.
- Keep each fact readable in one short sentence (or at most two short sentences).
- Keep text concise, factual, actionable, and non-duplicated.
- Do not invent facts not inferable from source text.
- Every fact must include a non-empty sourceSpan pointing to where it comes from in the reading material.
- Prefer beginner-useful facts (definition, rule, pitfall, insight, example_candidate).
- Avoid generic statements without concrete content.
- If no reliable fact exists for an item, return empty facts for that item.`;

    const response = await askAI(
      "Return one strict JSON object only. No markdown. No commentary.",
      `${basePrompt}

TOPIC/SUBTOPIC LIST (CHUNK):
${JSON.stringify(chunkTopics, null, 2)}

SOURCE READING MATERIAL:
${trimmedText}`,
      12000,
      { requireJson: true },
    );

    const responseText = String(response || "").trim();
    if (!responseText) {
      throw new Error("Facts extraction failed: model returned empty response");
    }

    let parsed: {
      topicFacts?: Array<{ topicTitle?: string; facts?: ExtractedFact[] }>;
      subtopicFacts?: Array<{ topicTitle?: string; subtopicTitle?: string; facts?: ExtractedFact[] }>;
    };
    try {
      parsed = parseFirstModelJsonObject<{
        topicFacts?: Array<{ topicTitle?: string; facts?: ExtractedFact[] }>;
        subtopicFacts?: Array<{ topicTitle?: string; subtopicTitle?: string; facts?: ExtractedFact[] }>;
      }>(responseText);
    } catch (parseErr) {
      const snippet = responseText.slice(0, 400).replace(/\s+/g, " ");
      const reason = parseErr instanceof Error ? parseErr.message : "unknown parse error";
      throw new Error(`Facts extraction JSON parse failed: ${reason}. Model snippet: ${snippet}`);
    }
    parseFactsRows(parsed, chunkTopics);
  };

  // Hard-cap calls to <= 3 per unit to respect low-RPM model quotas.
  const maxCallsPerUnit = 3;
  const totalItems = topics.reduce(
    (acc, topic) => acc + 1 + (Array.isArray(topic.subtopics) ? topic.subtopics.length : 0),
    0,
  );
  const desiredChunks = Math.min(maxCallsPerUnit, Math.max(1, topics.length));
  const maxItemsPerChunk = Math.max(1, Math.ceil(totalItems / desiredChunks));
  const chunks: UnitTopicInput[][] = [];
  let current: UnitTopicInput[] = [];
  let currentItems = 0;
  for (const topic of topics) {
    const topicItems = 1 + (Array.isArray(topic.subtopics) ? topic.subtopics.length : 0);
    if (current.length > 0 && currentItems + topicItems > maxItemsPerChunk && chunks.length < desiredChunks - 1) {
      chunks.push(current);
      current = [];
      currentItems = 0;
    }
    current.push(topic);
    currentItems += topicItems;
  }
  if (current.length > 0) chunks.push(current);

  // Ensure non-empty and capped.
  const finalChunks = chunks.length > 0 ? chunks : [topics.slice(0, 1)];
  for (const chunkTopics of finalChunks) {
    await extractChunk(chunkTopics);
  }

  return { topicFacts, subtopicFacts };
}

async function extractTopicsForMaterialsBatch(
  subjectName: string,
  materials: BatchMaterialInput[],
): Promise<Map<string, ExtractedMaterialStructure>> {
  const capped = materials.slice(0, 3).map((m) => ({
    materialId: m.materialId,
    explicitTitle: m.explicitTitle,
    titleHint: m.titleHint,
    readingText: m.readingText.slice(0, 18000),
  }));

  const normalizedSubject = normalizeText(subjectName);
  const isAptitudeLike =
    /(aptitude|numerical|quant|reasoning|probability|time and work|permutation|combination|pipes|cistern|man chain|wages)/i.test(
      normalizedSubject,
    );
  const subjectGuidance = isAptitudeLike
    ? `SUBJECT PROFILE: aptitude / numerical ability.
- Make topic titles chapter-like and method-specific (not generic labels).
- Avoid standalone vague topics: "Overview", "Concepts", "Methods", "Examples", "Rules and Tricks", "Practice".
- If source has a generic section, fold it into a concrete topic.
- Subtopics should be formula/rule/procedure/problem-pattern oriented and exam-solvable.
- Keep wording simple and direct for beginners.`
    : `SUBJECT PROFILE: general.
- Keep topic titles specific and exam-relevant.
- Avoid vague placeholders unless explicitly present as true headings in source.`;

  const prompt = `You are a syllabus structure extractor for "${subjectName}".

Extract exactly one unit structure for each reading material.

Return ONLY valid JSON:
{
  "materials": [
    {
      "materialId": "same id from input",
      "unitTitle": "single unit title for this material",
      "topics": [
        { "title": "Topic title", "subtopics": ["Subtopic 1", "Subtopic 2"] }
      ]
    }
  ]
}

STRICT RULES:
- Each materialId must appear exactly once.
- Exactly one unit per material. Never split one material into multiple units.
- Never merge materials.
- If explicitTitle is provided for a material, use it exactly as unitTitle.
- If explicitTitle is empty, choose a concise unitTitle from the material content.
- If unsure for a material with no explicitTitle, use its titleHint.
- Keep 2-8 topics per material when possible.
- Keep 2-6 subtopics per topic when possible.
- Use concise exam-relevant wording.
- Topic titles must be specific and informative.
- Subtopics must be concrete enough to generate exam questions directly.
- Never output a flattened outline inside a topic title. Do not return patterns like "Topic: item1, item2, item3".
- If source has section-style bullets under a heading, keep heading as topic and move bullets into subtopics.
- Topic title style:
  - Keep compact, map-friendly names (usually 3-7 words).
  - Titles must be meaningful standalone phrases, not clipped fragments.
  - MAP LABEL MODE: output should read like roadmap node labels (short noun phrases), not sentence fragments.
  - Keep one core concept per topic title.
  - Avoid long sentence-style titles.
  - Never include formulas, code conditions, or complexity expressions in titles (for example avoid "arr[i] >= x", "O(log n)", "mid = ..."). Put those in explanations instead.
  - Avoid generic titles like "Overview", "Concepts", "Introduction", "Theory", "Methods" unless truly present as a heading.
  - Never end a title with connector words like "and", "for", "with", "to", "of".
- Subtopic title style:
  - Keep compact, map-friendly labels (usually 2-6 words).
  - Prefer actionable short labels (for example: "Login request", "Handle login response", "Store JWT").
  - Subtopic titles must be understandable on their own.
  - MAP LABEL MODE: subtopic labels should be quick-scan node names, not explanatory clauses.
  - Keep one core concept per subtopic label.
  - Never include formula text or code-like expressions in titles.
  - Avoid redundant prefixes/suffixes like "Subtopic -", "Concept of", "Basics of".
  - Never end a title with connector words like "and", "for", "with", "to", "of".
- Remove heading numbering from output titles (e.g., "3.3.1 Cookies.set()" -> "Cookies.set()").
- Preserve source order.
- Do not duplicate near-identical titles.
- Keep acronyms and API/library names as-is (JWT, API, js-cookie, Navigate, Cookies.set).

${subjectGuidance}`;

  const response = await askAI(
    "You extract topic/subtopic structures and return strict JSON only.",
    `${prompt}

MATERIALS:
${JSON.stringify(capped, null, 2)}`,
    6500,
    { requireJson: true },
  );

  const parsed = parseFirstModelJsonObject<{
    materials?: Array<{
      materialId?: string;
      unitTitle?: string;
      topics?: Array<{ title?: string; subtopics?: string[] }>;
    }>;
  }>(response);

  const out = new Map<string, ExtractedMaterialStructure>();
  for (const row of parsed.materials ?? []) {
    const materialId = String(row?.materialId || "").trim();
    if (!materialId) continue;
    const unitTitle = cleanGeneratedHeading(row?.unitTitle);
    const topics = normalizeExtractedTopics(row.topics ?? []);
    out.set(materialId, {
      unitTitle,
      topics,
    });
  }

  return out;
}

router.get("/admin/library/subjects", requireAdmin, async (req, res) => {
  try {
    const subjects = await db
      .select({
        id: subjectsTable.id,
        name: subjectsTable.name,
        normalizedName: subjectsTable.normalizedName,
        createdAt: subjectsTable.createdAt,
        updatedAt: subjectsTable.updatedAt,
      })
      .from(subjectsTable);

    subjects.sort((a, b) => a.name.localeCompare(b.name));
    res.json(
      subjects.map((s) => ({
        ...s,
        createdAt: s.createdAt?.toISOString() ?? null,
        updatedAt: s.updatedAt?.toISOString() ?? null,
      })),
    );
  } catch (error) {
    req.log.error({ err: error }, "Failed to list library subjects");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin/library/subjects", requireAdmin, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const normalizedName = normalizeText(name);
    if (!normalizedName) {
      res.status(400).json({ error: "name is invalid" });
      return;
    }

    const [existing] = await db
      .select({ id: subjectsTable.id, name: subjectsTable.name })
      .from(subjectsTable)
      .where(eq(subjectsTable.normalizedName, normalizedName))
      .limit(1);

    const userId = String((req as any).userId || "admin");

    if (existing) {
      await db
        .update(subjectsTable)
        .set({
          name,
          updatedAt: new Date(),
        })
        .where(eq(subjectsTable.id, existing.id));

      res.json({ id: existing.id, name, normalizedName });
      return;
    }

    const id = `sub_${randomUUID().substring(0, 8)}`;
    await db.insert(subjectsTable).values({
      id,
      name,
      normalizedName,
      createdBy: userId,
    });

    res.status(201).json({ id, name, normalizedName });
  } catch (error) {
    req.log.error({ err: error }, "Failed to upsert library subject");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/admin/library/units", requireAdmin, async (req, res) => {
  try {
    const subjectId = String(req.query.subjectId || "").trim();
    if (!subjectId) {
      res.status(400).json({ error: "subjectId is required" });
      return;
    }

    const units = await db
      .select({
        id: unitLibraryTable.id,
        subjectId: unitLibraryTable.subjectId,
        unitTitle: unitLibraryTable.unitTitle,
        normalizedUnitTitle: unitLibraryTable.normalizedUnitTitle,
        topics: unitLibraryTable.topics,
        sourceText: unitLibraryTable.sourceText,
        createdBy: unitLibraryTable.createdBy,
        createdAt: unitLibraryTable.createdAt,
        updatedAt: unitLibraryTable.updatedAt,
      })
      .from(unitLibraryTable)
      .where(eq(unitLibraryTable.subjectId, subjectId));

    const unitIds = units.map((u) => u.id);
    const summaryByUnitId = new Map<
      string,
      {
        factAtomsCount: number;
        itemsWithFacts: number;
        itemsWithoutFacts: number;
        topicItems: number;
        subtopicItems: number;
      }
    >();

    for (const unit of units) {
      const topics = sanitizeTopics(unit.topics);
      const topicItems = topics.length;
      const subtopicItems = topics.reduce((acc, t) => acc + (Array.isArray(t.subtopics) ? t.subtopics.length : 0), 0);
      const totalItems = topicItems + subtopicItems;
      summaryByUnitId.set(unit.id, {
        factAtomsCount: 0,
        itemsWithFacts: 0,
        itemsWithoutFacts: totalItems,
        topicItems,
        subtopicItems,
      });
    }

    const unitFactsCounts = await loadUnitFactCountsFromUnitFacts(unitIds);
    const canonicalRows = unitIds.length > 0
      ? await db
          .select({
            unitLibraryId: canonicalNodesTable.unitLibraryId,
          })
          .from(canonicalNodesTable)
          .where(inArray(canonicalNodesTable.unitLibraryId, unitIds))
      : [];
    const canonicalCountByUnitId = new Map<string, number>();
    for (const row of canonicalRows) {
      const key = String(row.unitLibraryId || "").trim();
      if (!key) continue;
      canonicalCountByUnitId.set(key, (canonicalCountByUnitId.get(key) ?? 0) + 1);
    }

    if (unitFactsCounts) {
      for (const unit of units) {
        const current = summaryByUnitId.get(unit.id) ?? {
          factAtomsCount: 0,
          itemsWithFacts: 0,
          itemsWithoutFacts: 0,
          topicItems: 0,
          subtopicItems: 0,
        };
        current.factAtomsCount = unitFactsCounts.get(unit.id) ?? 0;
        summaryByUnitId.set(unit.id, current);
      }
    }

    units.sort((a, b) => a.unitTitle.localeCompare(b.unitTitle));
    res.json(
      units.map((u) => ({
        ...u,
        factsSummary: {
          factAtomsCount: summaryByUnitId.get(u.id)?.factAtomsCount ?? 0,
          itemsWithFacts: summaryByUnitId.get(u.id)?.itemsWithFacts ?? 0,
          itemsWithoutFacts: summaryByUnitId.get(u.id)?.itemsWithoutFacts ?? 0,
          topicItems: summaryByUnitId.get(u.id)?.topicItems ?? 0,
          subtopicItems: summaryByUnitId.get(u.id)?.subtopicItems ?? 0,
          hasFacts: (summaryByUnitId.get(u.id)?.factAtomsCount ?? 0) > 0,
        },
        canonicalNodeCount: canonicalCountByUnitId.get(u.id) ?? 0,
        hasCanonicalNodes: (canonicalCountByUnitId.get(u.id) ?? 0) > 0,
        createdAt: u.createdAt?.toISOString() ?? null,
        updatedAt: u.updatedAt?.toISOString() ?? null,
      })),
    );
  } catch (error) {
    req.log.error({ err: error }, "Failed to list library units");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin/library/units/extract-from-text", requireAdmin, async (req, res) => {
  try {
    const subjectId = String(req.body?.subjectId || "").trim();
    const materialsInput = Array.isArray(req.body?.materials)
      ? req.body.materials
      : [];
    const fallbackReadingText = String(req.body?.readingText || "").trim();
    const fallbackTitle = String(req.body?.materialTitle || "").trim();

    if (!subjectId) {
      res.status(400).json({ error: "subjectId is required" });
      return;
    }

    const [subject] = await db
      .select({ id: subjectsTable.id, name: subjectsTable.name })
      .from(subjectsTable)
      .where(eq(subjectsTable.id, subjectId))
      .limit(1);
    if (!subject) {
      res.status(404).json({ error: "Subject not found" });
      return;
    }

    const materials: BatchMaterialInput[] = (
      materialsInput.length > 0
        ? materialsInput
        : [{ id: "legacy-1", title: fallbackTitle, readingText: fallbackReadingText }]
    )
      .map((m: any, idx: number) => {
        const readingText = String(m?.readingText || "").trim();
        const explicitTitle = String(m?.title || "").trim();
        const materialId = String(m?.id || `material-${idx + 1}`).trim() || `material-${idx + 1}`;
        return {
          materialId,
          explicitTitle: explicitTitle || null,
          titleHint: createFallbackUnitTitle(),
          readingText,
        };
      })
      .filter((m: BatchMaterialInput) => m.readingText.length > 0);

    if (materials.length === 0) {
      res.status(400).json({ error: "At least one non-empty reading material is required" });
      return;
    }
    if (materials.length > 3) {
      res.status(400).json({ error: "You can extract up to 3 reading materials at once" });
      return;
    }

    const userId = String((req as any).userId || "admin");
    const extractedByMaterial = await extractTopicsForMaterialsBatch(subject.name, materials);
    const upserted: Array<{ id: string; unitTitle: string }> = [];

    for (const material of materials) {
      const extracted = extractedByMaterial.get(material.materialId);
      const resolvedUnitTitle = (
        material.explicitTitle ||
        extracted?.unitTitle ||
        material.titleHint
      ).trim();
      const extractedTopics = extracted?.topics ?? [];
      const cleanedTopics = makeCleanupGlanceableTopics(extractedTopics);
      const normalizedTopics = cleanedTopics.length > 0
        ? cleanedTopics
        : [{ title: "Overview", subtopics: ["Introduction"] }];

      const normalizedUnitTitle = normalizeText(resolvedUnitTitle);
      if (!normalizedUnitTitle) continue;
      let unitLibraryId = "";
      let effectiveUnitTitle = resolvedUnitTitle;
      let effectiveTopics = normalizedTopics;
      const [existing] = await db
        .select({
          id: unitLibraryTable.id,
          unitTitle: unitLibraryTable.unitTitle,
          topics: unitLibraryTable.topics,
          sourceText: unitLibraryTable.sourceText,
        })
        .from(unitLibraryTable)
        .where(and(
          eq(unitLibraryTable.subjectId, subjectId),
          eq(unitLibraryTable.normalizedUnitTitle, normalizedUnitTitle),
        ))
        .limit(1);

      if (existing) {
        // Keep extract-from-text deterministic: latest extraction replaces existing unit content.
        await db
          .update(unitLibraryTable)
          .set({
            unitTitle: resolvedUnitTitle,
            topics: normalizedTopics,
            sourceText: material.readingText,
            updatedAt: new Date(),
          })
          .where(eq(unitLibraryTable.id, existing.id));

        effectiveUnitTitle = resolvedUnitTitle;
        effectiveTopics = normalizedTopics;
        unitLibraryId = existing.id;
        upserted.push({ id: existing.id, unitTitle: resolvedUnitTitle });
      } else {
        const id = `unit_${randomUUID().substring(0, 8)}`;
        await db.insert(unitLibraryTable).values({
          id,
          subjectId,
          unitTitle: resolvedUnitTitle,
          normalizedUnitTitle,
          topics: normalizedTopics,
          sourceText: material.readingText,
          createdBy: userId,
        });
        unitLibraryId = id;
        upserted.push({ id, unitTitle: resolvedUnitTitle });
      }

      if (!unitLibraryId || effectiveTopics.length === 0) continue;

      const extractedFacts = await extractFactsForMaterial(
        subject.name,
        effectiveUnitTitle,
        effectiveTopics,
        material.readingText,
      );
      const topicFacts = extractedFacts.topicFacts;
      const subtopicFacts = extractedFacts.subtopicFacts;

      await saveFactsToUnitFacts(unitLibraryId, effectiveTopics, topicFacts, subtopicFacts);
    }

    res.json({
      success: true,
      subjectId,
      extractedCount: upserted.length,
      units: upserted,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to extract units from text");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin/library/units/upsert", requireAdmin, async (req, res) => {
  try {
    const subjectId = String(req.body?.subjectId || "").trim();
    const unitTitle = String(req.body?.unitTitle || "").trim();
    const sourceText = req.body?.sourceText ? String(req.body.sourceText) : null;
    const topics = normalizeAndSanitizeTopics(req.body?.topics);

    if (!subjectId || !unitTitle) {
      res.status(400).json({ error: "subjectId and unitTitle are required" });
      return;
    }

    const [subject] = await db
      .select({ id: subjectsTable.id })
      .from(subjectsTable)
      .where(eq(subjectsTable.id, subjectId))
      .limit(1);
    if (!subject) {
      res.status(404).json({ error: "Subject not found" });
      return;
    }

    const normalizedUnitTitle = normalizeText(unitTitle);
    if (!normalizedUnitTitle) {
      res.status(400).json({ error: "unitTitle is invalid" });
      return;
    }

    const [existing] = await db
      .select({ id: unitLibraryTable.id })
      .from(unitLibraryTable)
      .where(and(
        eq(unitLibraryTable.subjectId, subjectId),
        eq(unitLibraryTable.normalizedUnitTitle, normalizedUnitTitle),
      ))
      .limit(1);

    const userId = String((req as any).userId || "admin");

    if (existing) {
      await db
        .update(unitLibraryTable)
        .set({
          unitTitle,
          topics,
          sourceText,
          updatedAt: new Date(),
        })
        .where(eq(unitLibraryTable.id, existing.id));

      res.json({
        id: existing.id,
        subjectId,
        unitTitle,
        normalizedUnitTitle,
        topics,
        sourceText,
      });
      return;
    }

    const id = `unit_${randomUUID().substring(0, 8)}`;
    await db.insert(unitLibraryTable).values({
      id,
      subjectId,
      unitTitle,
      normalizedUnitTitle,
      topics,
      sourceText,
      createdBy: userId,
    });

    res.status(201).json({
      id,
      subjectId,
      unitTitle,
      normalizedUnitTitle,
      topics,
      sourceText,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to upsert library unit");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/admin/library/units/:id", requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }

    const [existing] = await db
      .select({
        id: unitLibraryTable.id,
        subjectId: unitLibraryTable.subjectId,
      })
      .from(unitLibraryTable)
      .where(eq(unitLibraryTable.id, id))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Unit not found" });
      return;
    }

    const nextUnitTitleRaw = req.body?.unitTitle;
    const nextTopicsRaw = req.body?.topics;
    const nextSourceRaw = req.body?.sourceText;

    const patch: {
      unitTitle?: string;
      normalizedUnitTitle?: string;
      topics?: UnitTopicInput[];
      sourceText?: string | null;
      updatedAt: Date;
    } = { updatedAt: new Date() };

    if (typeof nextUnitTitleRaw === "string") {
      const unitTitle = nextUnitTitleRaw.trim();
      if (!unitTitle) {
        res.status(400).json({ error: "unitTitle cannot be empty" });
        return;
      }
      const normalized = normalizeText(unitTitle);
      const [duplicate] = await db
        .select({ id: unitLibraryTable.id })
        .from(unitLibraryTable)
        .where(and(
          eq(unitLibraryTable.subjectId, existing.subjectId),
          eq(unitLibraryTable.normalizedUnitTitle, normalized),
        ))
        .limit(1);

      if (duplicate && duplicate.id !== id) {
        res.status(409).json({ error: "A unit with this title already exists for the subject" });
        return;
      }

      patch.unitTitle = unitTitle;
      patch.normalizedUnitTitle = normalized;
    }

    if (nextTopicsRaw !== undefined) {
      patch.topics = normalizeAndSanitizeTopics(nextTopicsRaw);
    }

    if (nextSourceRaw !== undefined) {
      patch.sourceText = nextSourceRaw ? String(nextSourceRaw) : null;
    }

    await db
      .update(unitLibraryTable)
      .set(patch)
      .where(eq(unitLibraryTable.id, id));

    const [updated] = await db
      .select()
      .from(unitLibraryTable)
      .where(eq(unitLibraryTable.id, id))
      .limit(1);

    res.json({
      ...updated,
      createdAt: updated.createdAt?.toISOString() ?? null,
      updatedAt: updated.updatedAt?.toISOString() ?? null,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to update library unit");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin/library/units/:id/cleanup-titles", requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const preview = String(req.query.preview || "").trim().toLowerCase() === "true";
    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }

    const [existing] = await db
      .select({
        id: unitLibraryTable.id,
        subjectId: unitLibraryTable.subjectId,
        unitTitle: unitLibraryTable.unitTitle,
        sourceText: unitLibraryTable.sourceText,
        topics: unitLibraryTable.topics,
      })
      .from(unitLibraryTable)
      .where(eq(unitLibraryTable.id, id))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Unit not found" });
      return;
    }

    const canonicalForUnit = await db
      .select({ id: canonicalNodesTable.id })
      .from(canonicalNodesTable)
      .where(eq(canonicalNodesTable.unitLibraryId, id))
      .limit(1);
    if (canonicalForUnit.length > 0) {
      res.status(409).json({
        error: "Cleanup is disabled because canonical nodes already exist for this unit.",
      });
      return;
    }

    const beforeTopics = sanitizeTopics(existing.topics);
    const sourceText = String(existing.sourceText || "").trim();
    if (!sourceText) {
      res.status(400).json({
        error: "Reading material (sourceText) is empty for this unit. Add reading material text first.",
      });
      return;
    }

    const [subject] = await db
      .select({ id: subjectsTable.id, name: subjectsTable.name })
      .from(subjectsTable)
      .where(eq(subjectsTable.id, existing.subjectId))
      .limit(1);
    if (!subject) {
      res.status(404).json({ error: "Subject not found for unit" });
      return;
    }

    const extractedByMaterial = await extractTopicsForMaterialsBatch(subject.name, [
      {
        materialId: id,
        explicitTitle: String(existing.unitTitle || "").trim() || null,
        titleHint: String(existing.unitTitle || "").trim() || "Unit",
        readingText: sourceText,
      },
    ]);
    const extracted = extractedByMaterial.get(id);
    const cleanedTopics = makeCleanupGlanceableTopics(extracted?.topics ?? []);
    if (cleanedTopics.length === 0) {
      res.status(422).json({
        error: "Could not generate topic/subtopic titles from reading material. Please update reading material and retry.",
      });
      return;
    }

    const updated = JSON.stringify(beforeTopics) !== JSON.stringify(cleanedTopics);

    if (updated && !preview) {
      await db
        .update(unitLibraryTable)
        .set({
          topics: cleanedTopics,
          updatedAt: new Date(),
        })
        .where(eq(unitLibraryTable.id, id));
    }

    const topicCountBefore = beforeTopics.length;
    const topicCountAfter = cleanedTopics.length;
    const subtopicCountBefore = beforeTopics.reduce((acc, topic) => acc + topic.subtopics.length, 0);
    const subtopicCountAfter = cleanedTopics.reduce((acc, topic) => acc + topic.subtopics.length, 0);

    res.json({
      success: true,
      unitId: id,
      preview,
      updated,
      topicCountBefore,
      topicCountAfter,
      subtopicCountBefore,
      subtopicCountAfter,
      topics: cleanedTopics,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to cleanup unit titles");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/admin/library/config-units", requireAdmin, async (req, res) => {
  try {
    const configId = String(req.query.configId || "").trim();
    if (!configId) {
      res.status(400).json({ error: "configId is required" });
      return;
    }

    const links = await db
      .select({
        unitLibraryId: configUnitLinksTable.unitLibraryId,
        sortOrder: configUnitLinksTable.sortOrder,
      })
      .from(configUnitLinksTable)
      .where(eq(configUnitLinksTable.configId, configId));

    links.sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
    res.json({
      configId,
      unitIds: links.map((l) => l.unitLibraryId),
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to fetch config unit links");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/admin/library/config-units/:configId", requireAdmin, async (req, res) => {
  try {
    const configId = String(req.params.configId || "").trim();
    const unitIds = Array.isArray(req.body?.unitIds)
      ? req.body.unitIds.filter((v: unknown) => typeof v === "string").map((v: string) => v.trim()).filter(Boolean)
      : [];

    if (!configId) {
      res.status(400).json({ error: "configId is required" });
      return;
    }

    const [config] = await db
      .select({ id: configsTable.id, subject: configsTable.subject })
      .from(configsTable)
      .where(eq(configsTable.id, configId))
      .limit(1);
    if (!config) {
      res.status(404).json({ error: "Config not found" });
      return;
    }

    if (unitIds.length > 0) {
      const existingUnits = await db
        .select({ id: unitLibraryTable.id })
        .from(unitLibraryTable)
        .where(inArray(unitLibraryTable.id, unitIds));
      const existingSet = new Set(existingUnits.map((u) => u.id));
      const missing = unitIds.filter((id) => !existingSet.has(id));
      if (missing.length > 0) {
        res.status(400).json({ error: `Unknown unit ids: ${missing.join(", ")}` });
        return;
      }
    }

    const subjectNormalized = normalizeText(config.subject);
    let [subject] = await db
      .select({ id: subjectsTable.id })
      .from(subjectsTable)
      .where(eq(subjectsTable.normalizedName, subjectNormalized))
      .limit(1);
    if (!subject) {
      const subjectId = `sub_${toSlug(config.subject)}_${randomUUID().substring(0, 8)}`;
      await db.insert(subjectsTable).values({
        id: subjectId,
        name: config.subject,
        normalizedName: subjectNormalized,
        createdBy: String((req as any).userId || "admin"),
      });
      subject = { id: subjectId };
    }

    // Phase 1: Persist selected unit links (authoritative source for selection).
    await db.transaction(async (tx) => {
      await tx
        .delete(configUnitLinksTable)
        .where(eq(configUnitLinksTable.configId, configId));

      for (let i = 0; i < unitIds.length; i++) {
        await tx.insert(configUnitLinksTable).values({
          id: `cul_${randomUUID().substring(0, 10)}`,
          configId,
          unitLibraryId: unitIds[i],
          sortOrder: i + 1,
        });
      }
    });

    // Phase 2: Best-effort node tree materialization. If this fails, keep links intact.
    let materialized = true;
    let materializeError: string | null = null;
    try {
      await db.transaction(async (tx) => {
        await tx
          .delete(nodesTable)
          .where(eq(nodesTable.configId, configId));
        await materializeConfigNodesFromSelectedUnits(tx, configId, subject.id, unitIds);
      });
    } catch (err) {
      materialized = false;
      materializeError = err instanceof Error ? err.message : "Failed to materialize roadmap nodes";
      req.log.error({ err, configId }, "Unit links saved but node materialization failed");
    }

    res.json({
      success: true,
      configId,
      unitIds,
      nodesMaterialized: materialized,
      warning: materialized ? null : materializeError,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to update config unit links");
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

router.post("/admin/library/units/:id/generate-facts", requireAdmin, async (req, res) => {
  try {
    const unitId = String(req.params.id || "").trim();
    if (!unitId) {
      res.status(400).json({ error: "unit id is required" });
      return;
    }

    const [unit] = await db
      .select({
        id: unitLibraryTable.id,
        subjectId: unitLibraryTable.subjectId,
        unitTitle: unitLibraryTable.unitTitle,
        topics: unitLibraryTable.topics,
        sourceText: unitLibraryTable.sourceText,
      })
      .from(unitLibraryTable)
      .where(eq(unitLibraryTable.id, unitId))
      .limit(1);

    if (!unit) {
      res.status(404).json({ error: "Unit not found" });
      return;
    }

    const [subject] = await db
      .select({ id: subjectsTable.id, name: subjectsTable.name })
      .from(subjectsTable)
      .where(eq(subjectsTable.id, unit.subjectId))
      .limit(1);
    if (!subject) {
      res.status(404).json({ error: "Subject not found for unit" });
      return;
    }

    const topics = sanitizeTopics(unit.topics);
    if (topics.length === 0) {
      res.status(400).json({ error: "Unit has no topics/subtopics to generate facts for" });
      return;
    }

    const sourceText = String(unit.sourceText || "").trim();
    if (!sourceText) {
      res.status(400).json({ error: "Reading material (sourceText) is empty for this unit. Update unit source text first." });
      return;
    }

    const extracted = await extractFactsForMaterial(subject.name, unit.unitTitle, topics, sourceText);
    await saveFactsToUnitFacts(unit.id, topics, extracted.topicFacts, extracted.subtopicFacts);

    const countMap = await loadUnitFactCountsFromUnitFacts([unit.id]);
    const factCount = countMap?.get(unit.id) ?? 0;

    res.json({
      success: true,
      unitId: unit.id,
      factCount,
      replaced: true,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to regenerate facts for unit");
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;

