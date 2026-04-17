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

function cleanGeneratedHeading(raw: unknown): string {
  return String(raw || "")
    .replace(/^\s*\d+(\.\d+)*\s*[-.)]?\s*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.:;,\-–—\s]+$/g, "")
    .trim();
}

function compactTopicTitle(raw: unknown): string {
  const t = cleanGeneratedHeading(raw)
    .replace(/^third\s+party\s+package\s*[-:]\s*/i, "")
    .replace(/^topic\s*[-:]\s*/i, "")
    .trim();
  return t;
}

function compactSubtopicTitle(raw: unknown): string {
  return cleanGeneratedHeading(raw)
    .replace(/^subtopic\s*[-:]\s*/i, "")
    .trim();
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
  const units = await tx
    .select({
      id: unitLibraryTable.id,
      unitTitle: unitLibraryTable.unitTitle,
      topics: unitLibraryTable.topics,
    })
    .from(unitLibraryTable)
    .where(inArray(unitLibraryTable.id, unitIds));
  const unitById = new Map(units.map((u) => [u.id, u]));
  const orderedUnits = unitIds.map((id) => unitById.get(id)).filter((u): u is NonNullable<typeof u> => !!u);

  const existingCanonicalRows = await tx
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
    .where(inArray(canonicalNodesTable.unitLibraryId, unitIds));

  const existingById = new Map(existingCanonicalRows.map((r) => [r.id, r]));
  const existingTopicByKey = new Map<string, (typeof existingCanonicalRows)[number]>();
  const existingSubtopicByKey = new Map<string, (typeof existingCanonicalRows)[number]>();
  for (const row of existingCanonicalRows) {
    if (row.type === "topic") {
      existingTopicByKey.set(`${row.unitLibraryId}|${normalizeText(row.title)}`, row);
      continue;
    }
    if (row.type === "subtopic") {
      const parent = row.parentCanonicalNodeId ? existingById.get(row.parentCanonicalNodeId) : null;
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
  const factTextCol = ["fact_text", "text", "fact", "content"].find((c) => colSet.has(c));
  const factTypeCol = ["fact_type", "type"].find((c) => colSet.has(c));
  const factIdCol = ["fact_id", "id"].find((c) => colSet.has(c));
  const sourceCol = ["source_span", "source", "source_text", "source_ref"].find((c) => colSet.has(c));
  const createdAtCol = colSet.has("created_at") ? "created_at" : null;
  const updatedAtCol = colSet.has("updated_at") ? "updated_at" : null;

  if (!unitCol || !factTextCol) return;

  await pool.query(`DELETE FROM public.unit_facts WHERE CAST(${unitCol} AS text) = $1`, [unitLibraryId]);

  const rows: Array<{
    topicTitle: string;
    subtopicTitle: string;
    factText: string;
    factType: string;
    factId: string;
    sourceSpan: string;
  }> = [];
  for (const topic of topics) {
    const topicTitle = String(topic.title || "").trim();
    if (!topicTitle) continue;
    const topicKey = normalizeText(topicTitle);
    for (const fact of topicFacts.get(topicKey) ?? []) {
      const text = String(fact?.text || "").trim();
      if (!text) continue;
      rows.push({
        topicTitle,
        subtopicTitle: "",
        factText: text,
        factType: String(fact?.type || "note"),
        factId: String(fact?.factId || "").trim(),
        sourceSpan: String(fact?.sourceSpan || "").trim(),
      });
    }

    for (const subtopicRaw of topic.subtopics ?? []) {
      const subtopicTitle = String(subtopicRaw || "").trim();
      if (!subtopicTitle) continue;
      const factsKey = `${topicKey}|${normalizeText(subtopicTitle)}`;
      for (const fact of subtopicFacts.get(factsKey) ?? []) {
        const text = String(fact?.text || "").trim();
        if (!text) continue;
        rows.push({
          topicTitle,
          subtopicTitle,
          factText: text,
          factType: String(fact?.type || "note"),
          factId: String(fact?.factId || "").trim(),
          sourceSpan: String(fact?.sourceSpan || "").trim(),
        });
      }
    }
  }

  if (rows.length === 0) return;

  for (const row of rows) {
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
    columnsSql.push(factTextCol);
    valuesSql.push(`$${index++}`);
    values.push(row.factText);
    if (factTypeCol) {
      columnsSql.push(factTypeCol);
      valuesSql.push(`$${index++}`);
      values.push(row.factType);
    }
    if (factIdCol) {
      columnsSql.push(factIdCol);
      valuesSql.push(`$${index++}`);
      values.push(row.factId || randomUUID());
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
  const trimmedText = String(readingText || "").trim().slice(0, 18000);
  if (!trimmedText) return { topicFacts: new Map(), subtopicFacts: new Map() };

  const prompt = `You are extracting factual grounding atoms for exam-prep generation.

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
- Use only topic/subtopic titles provided below (exact match).
- 1 to 6 short facts per topic/subtopic.
- Keep text concise, factual, non-duplicated.
- Do not invent facts not inferable from source text.
- Prefer beginner-useful facts.
- If no reliable fact exists for an item, return empty facts for that item.`;

  const response = await askAI(
    "You extract strict JSON fact grounding atoms from reading material.",
    `${prompt}

TOPIC/SUBTOPIC LIST:
${JSON.stringify(topics, null, 2)}

SOURCE READING MATERIAL:
${trimmedText}`,
    6500,
    { requireJson: true },
  );

  const parsed = parseFirstModelJsonObject<{
    topicFacts?: Array<{ topicTitle?: string; facts?: ExtractedFact[] }>;
    subtopicFacts?: Array<{ topicTitle?: string; subtopicTitle?: string; facts?: ExtractedFact[] }>;
  }>(response);

  const allow = new Set(["definition", "rule", "note", "pitfall", "insight", "example_candidate"]);
  const normTopicSet = new Set(topics.map((t) => normalizeText(t.title)));
  const normSubtopicSet = new Set(
    topics.flatMap((t) => t.subtopics.map((s) => `${normalizeText(t.title)}|${normalizeText(s)}`))
  );

  const topicFacts = new Map<string, ExtractedFact[]>();
  for (const row of parsed.topicFacts ?? []) {
    const topicTitle = String(row?.topicTitle || "").trim();
    const normTopic = normalizeText(topicTitle);
    if (!normTopic || !normTopicSet.has(normTopic)) continue;
    const facts = (Array.isArray(row?.facts) ? row.facts : [])
      .map((f) => ({
        factId: String(f?.factId || `uf_${randomUUID().slice(0, 8)}`).trim(),
        type: allow.has(String(f?.type || "").trim()) ? (String(f?.type || "").trim() as ExtractedFact["type"]) : "note",
        text: String(f?.text || "").trim(),
        sourceSpan: String(f?.sourceSpan || "").trim(),
      }))
      .filter((f) => f.text);
    topicFacts.set(normTopic, facts);
  }

  const subtopicFacts = new Map<string, ExtractedFact[]>();
  for (const row of parsed.subtopicFacts ?? []) {
    const topicTitle = String(row?.topicTitle || "").trim();
    const subtopicTitle = String(row?.subtopicTitle || "").trim();
    const key = `${normalizeText(topicTitle)}|${normalizeText(subtopicTitle)}`;
    if (!normSubtopicSet.has(key)) continue;
    const facts = (Array.isArray(row?.facts) ? row.facts : [])
      .map((f) => ({
        factId: String(f?.factId || `uf_${randomUUID().slice(0, 8)}`).trim(),
        type: allow.has(String(f?.type || "").trim()) ? (String(f?.type || "").trim() as ExtractedFact["type"]) : "note",
        text: String(f?.text || "").trim(),
        sourceSpan: String(f?.sourceSpan || "").trim(),
      }))
      .filter((f) => f.text);
    subtopicFacts.set(key, facts);
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
- Topic title style:
  - Keep compact, map-friendly names (prefer 1-4 words).
  - Avoid long sentence-style titles.
  - Avoid generic titles like "Overview", "Concepts", "Introduction", "Theory", "Methods" unless truly present as a heading.
- Subtopic title style:
  - Keep compact, map-friendly labels (prefer 1-5 words).
  - Prefer actionable short labels (for example: "Login request", "Handle login response", "Store JWT").
  - Avoid redundant prefixes/suffixes like "Subtopic -", "Concept of", "Basics of".
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
    const topics = (row.topics ?? [])
      .map((t) => {
        const title = compactTopicTitle(t?.title);
        const seenSub = new Set<string>();
        const subtopics = (Array.isArray(t?.subtopics) ? t.subtopics : [])
          .map((s) => compactSubtopicTitle(s))
          .filter((s) => {
            if (!s) return false;
            const k = normalizeText(s);
            if (!k || seenSub.has(k)) return false;
            seenSub.add(k);
            return true;
          });
        return { title, subtopics };
      })
      .filter((t) => t.title.length > 0);
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
      const topics = extracted?.topics ?? [];
      const normalizedTopics = topics.length > 0
        ? topics
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
        const existingTopics = Array.isArray(existing.topics) ? existing.topics : [];
        const hasExistingTopics = existingTopics.length > 0;
        const hasExistingSource = Boolean((existing.sourceText ?? "").trim());
        effectiveTopics = hasExistingTopics ? sanitizeTopics(existingTopics) : normalizedTopics;
        const patch: {
          unitTitle?: string;
          topics?: UnitTopicInput[];
          sourceText?: string;
          updatedAt: Date;
        } = { updatedAt: new Date() };
        let shouldUpdate = false;

        // Preserve existing extracted/edited content. Only fill missing values.
        if (!String(existing.unitTitle || "").trim()) {
          patch.unitTitle = resolvedUnitTitle;
          shouldUpdate = true;
        }
        if (!hasExistingTopics) {
          patch.topics = normalizedTopics;
          shouldUpdate = true;
        }
        if (!hasExistingSource) {
          patch.sourceText = material.readingText;
          shouldUpdate = true;
        }

        if (shouldUpdate) {
          await db
            .update(unitLibraryTable)
            .set(patch)
            .where(eq(unitLibraryTable.id, existing.id));
          if (patch.unitTitle) {
            effectiveUnitTitle = patch.unitTitle;
          } else if (existing.unitTitle) {
            effectiveUnitTitle = existing.unitTitle;
          }
        } else if (existing.unitTitle) {
          effectiveUnitTitle = existing.unitTitle;
        }
        unitLibraryId = existing.id;
        upserted.push({ id: existing.id, unitTitle: existing.unitTitle || resolvedUnitTitle });
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

      let topicFacts = new Map<string, ExtractedFact[]>();
      let subtopicFacts = new Map<string, ExtractedFact[]>();
      try {
        const extractedFacts = await extractFactsForMaterial(
          subject.name,
          effectiveUnitTitle,
          effectiveTopics,
          material.readingText,
        );
        topicFacts = extractedFacts.topicFacts;
        subtopicFacts = extractedFacts.subtopicFacts;
      } catch (factErr) {
        req.log.warn(
          { err: factErr, subjectId, unitTitle: effectiveUnitTitle },
          "Facts extraction failed for unit; continuing with structure-only save",
        );
      }

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
    const topics = sanitizeTopics(req.body?.topics);

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
      patch.topics = sanitizeTopics(nextTopicsRaw);
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

export default router;

