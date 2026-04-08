#!/usr/bin/env node
import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

const targetUrl = process.env.TARGET_DATABASE_URL || process.env.DATABASE_URL || process.argv[2];
if (!targetUrl) {
  console.error("Usage:");
  console.error("  TARGET_DATABASE_URL=... node scripts/refactor_content_model.mjs");
  console.error("or");
  console.error("  node scripts/refactor_content_model.mjs <target_database_url>");
  process.exit(1);
}

const ssl = targetUrl.includes("supabase.com") ? { rejectUnauthorized: false } : undefined;
const pool = new Pool({ connectionString: targetUrl, ssl });

function normalizeTitle(input) {
  return String(input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function toSlug(input) {
  const normalized = normalizeTitle(input);
  return normalized ? normalized.replace(/\s+/g, "_") : "untitled";
}

function chooseBySortOrder(list, sortOrder) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const idx = Number.parseInt(String(sortOrder ?? ""), 10);
  if (Number.isFinite(idx) && idx > 0 && idx <= list.length) return list[idx - 1];
  return null;
}

function normalizeSortOrder(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed)) return String(parsed);
  return raw;
}

async function ensureSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.unit_topics (
      id text PRIMARY KEY,
      unit_library_id text NOT NULL REFERENCES public.unit_library(id) ON DELETE CASCADE,
      title text NOT NULL,
      normalized_title text NOT NULL,
      sort_order integer NOT NULL DEFAULT 0,
      explanation text,
      created_at timestamp without time zone NOT NULL DEFAULT now(),
      updated_at timestamp without time zone NOT NULL DEFAULT now()
    );
  `);

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS unit_topics_unit_norm_unique
    ON public.unit_topics (unit_library_id, normalized_title);
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS unit_topics_unit_sort_idx
    ON public.unit_topics (unit_library_id, sort_order);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS public.unit_subtopics (
      id text PRIMARY KEY,
      unit_topic_id text NOT NULL REFERENCES public.unit_topics(id) ON DELETE CASCADE,
      title text NOT NULL,
      normalized_title text NOT NULL,
      sort_order integer NOT NULL DEFAULT 0,
      explanation text,
      created_at timestamp without time zone NOT NULL DEFAULT now(),
      updated_at timestamp without time zone NOT NULL DEFAULT now()
    );
  `);

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS unit_subtopics_topic_norm_unique
    ON public.unit_subtopics (unit_topic_id, normalized_title);
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS unit_subtopics_topic_sort_idx
    ON public.unit_subtopics (unit_topic_id, sort_order);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS public.config_questions (
      id bigserial PRIMARY KEY,
      config_id text NOT NULL REFERENCES public.configs(id) ON DELETE CASCADE,
      unit_subtopic_id text NOT NULL REFERENCES public.unit_subtopics(id) ON DELETE CASCADE,
      mark_type text NOT NULL,
      question text NOT NULL,
      answer text NOT NULL,
      is_starred boolean NOT NULL DEFAULT false,
      star_source text NOT NULL DEFAULT 'none',
      legacy_node_id text,
      legacy_question_id integer UNIQUE,
      created_at timestamp without time zone NOT NULL DEFAULT now(),
      updated_at timestamp without time zone NOT NULL DEFAULT now()
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS config_questions_config_idx
    ON public.config_questions (config_id);
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS config_questions_subtopic_idx
    ON public.config_questions (unit_subtopic_id);
  `);

  await client.query(`
    ALTER TABLE public.nodes
    ADD COLUMN IF NOT EXISTS unit_topic_id text;
  `);

  await client.query(`
    ALTER TABLE public.nodes
    ADD COLUMN IF NOT EXISTS unit_subtopic_id text;
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS nodes_config_unit_topic_idx
    ON public.nodes (config_id, unit_topic_id);
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS nodes_config_unit_subtopic_idx
    ON public.nodes (config_id, unit_subtopic_id);
  `);
}

async function run() {
  const startedAt = Date.now();
  const report = {
    unitsRead: 0,
    unitNodesMappedByTitle: 0,
    unitNodesMappedBySort: 0,
    unitNodesUnmapped: 0,
    topicsUpserted: 0,
    subtopicsUpserted: 0,
    topicNodesMapped: 0,
    topicNodesUnmapped: 0,
    subtopicNodesMapped: 0,
    subtopicNodesUnmapped: 0,
    topicExplanationsUpdated: 0,
    subtopicExplanationsUpdated: 0,
    configQuestionsUpserted: 0,
    configQuestionsUnmapped: 0,
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureSchema(client);

    const unitTopicsByUnit = new Map();
    const unitTopicIdByKey = new Map();
    const unitSubtopicsByTopic = new Map();
    const unitSubtopicIdByKey = new Map();

    const unitsResult = await client.query(`
      SELECT id, topics
      FROM public.unit_library
      ORDER BY id ASC
    `);
    report.unitsRead = unitsResult.rows.length;

    for (const unit of unitsResult.rows) {
      const unitId = String(unit.id);
      const topics = Array.isArray(unit.topics) ? unit.topics : [];
      const knownTopics = [];

      for (let ti = 0; ti < topics.length; ti += 1) {
        const topicTitleRaw = topics[ti]?.title ?? "";
        const topicTitle = String(topicTitleRaw || "").trim();
        if (!topicTitle) continue;
        const normalizedTopic = normalizeTitle(topicTitle);
        if (!normalizedTopic) continue;

        const topicIdCandidate = `utp_${unitId}_${toSlug(topicTitle)}`;
        const topicResult = await client.query(
          `
          INSERT INTO public.unit_topics (id, unit_library_id, title, normalized_title, sort_order)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (unit_library_id, normalized_title)
          DO UPDATE SET
            title = EXCLUDED.title,
            sort_order = EXCLUDED.sort_order,
            updated_at = now()
          RETURNING id
          `,
          [topicIdCandidate, unitId, topicTitle, normalizedTopic, ti + 1],
        );
        report.topicsUpserted += 1;
        const topicId = String(topicResult.rows[0].id);
        knownTopics.push({ id: topicId, normalizedTitle: normalizedTopic, sortOrder: ti + 1 });
        unitTopicIdByKey.set(`${unitId}|${normalizedTopic}`, topicId);

        const subtopicsRaw = Array.isArray(topics[ti]?.subtopics) ? topics[ti].subtopics : [];
        const knownSubtopics = [];
        for (let si = 0; si < subtopicsRaw.length; si += 1) {
          const subtopicTitle = String(subtopicsRaw[si] ?? "").trim();
          if (!subtopicTitle) continue;
          const normalizedSubtopic = normalizeTitle(subtopicTitle);
          if (!normalizedSubtopic) continue;

          const subtopicIdCandidate = `ust_${topicId}_${toSlug(subtopicTitle)}`;
          const subtopicResult = await client.query(
            `
            INSERT INTO public.unit_subtopics (id, unit_topic_id, title, normalized_title, sort_order)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (unit_topic_id, normalized_title)
            DO UPDATE SET
              title = EXCLUDED.title,
              sort_order = EXCLUDED.sort_order,
              updated_at = now()
            RETURNING id
            `,
            [subtopicIdCandidate, topicId, subtopicTitle, normalizedSubtopic, si + 1],
          );
          report.subtopicsUpserted += 1;
          const subtopicId = String(subtopicResult.rows[0].id);
          knownSubtopics.push({ id: subtopicId, normalizedTitle: normalizedSubtopic, sortOrder: si + 1 });
          unitSubtopicIdByKey.set(`${topicId}|${normalizedSubtopic}`, subtopicId);
          unitSubtopicIdByKey.set(`${unitId}|${normalizedTopic}|${normalizedSubtopic}`, subtopicId);
        }

        knownSubtopics.sort((a, b) => a.sortOrder - b.sortOrder);
        unitSubtopicsByTopic.set(topicId, knownSubtopics);
      }

      knownTopics.sort((a, b) => a.sortOrder - b.sortOrder);
      unitTopicsByUnit.set(unitId, knownTopics);
    }

    const linksResult = await client.query(`
      SELECT
        cul.config_id,
        cul.unit_library_id,
        cul.sort_order,
        ul.unit_title AS canonical_unit_title
      FROM public.config_unit_links cul
      JOIN public.unit_library ul ON ul.id = cul.unit_library_id
    `);
    const unitLibraryByConfigAndSort = new Map();
    const unitLibraryByConfigAndTitle = new Map();
    const duplicateConfigAndTitleKeys = new Set();
    for (const row of linksResult.rows) {
      const cfg = String(row.config_id);
      const sort = normalizeSortOrder(row.sort_order);
      if (sort) {
        unitLibraryByConfigAndSort.set(`${cfg}|${sort}`, String(row.unit_library_id));
      }

      const normalizedTitle = normalizeTitle(row.canonical_unit_title);
      if (!normalizedTitle) continue;
      const titleKey = `${cfg}|${normalizedTitle}`;
      const mappedUnit = String(row.unit_library_id);
      const existing = unitLibraryByConfigAndTitle.get(titleKey);
      if (existing && existing !== mappedUnit) {
        duplicateConfigAndTitleKeys.add(titleKey);
        unitLibraryByConfigAndTitle.delete(titleKey);
        continue;
      }
      if (!duplicateConfigAndTitleKeys.has(titleKey)) {
        unitLibraryByConfigAndTitle.set(titleKey, mappedUnit);
      }
    }

    const unitNodesResult = await client.query(`
      SELECT id, config_id, title, sort_order
      FROM public.nodes
      WHERE type = 'unit'
    `);
    const unitLibraryByUnitNodeId = new Map();
    for (const row of unitNodesResult.rows) {
      const configId = String(row.config_id);
      const normalizedUnitTitle = normalizeTitle(row.title);
      let unitLibraryId = normalizedUnitTitle
        ? unitLibraryByConfigAndTitle.get(`${configId}|${normalizedUnitTitle}`)
        : null;

      if (unitLibraryId) {
        report.unitNodesMappedByTitle += 1;
      } else {
        const sort = normalizeSortOrder(row.sort_order);
        unitLibraryId = sort ? unitLibraryByConfigAndSort.get(`${configId}|${sort}`) : null;
        if (unitLibraryId) {
          report.unitNodesMappedBySort += 1;
        } else {
          report.unitNodesUnmapped += 1;
        }
      }

      if (unitLibraryId) unitLibraryByUnitNodeId.set(String(row.id), unitLibraryId);
    }

    const topicNodesResult = await client.query(`
      SELECT id, config_id, parent_id, title, sort_order, explanation
      FROM public.nodes
      WHERE type = 'topic'
    `);
    const canonicalTopicByTopicNodeId = new Map();
    const bestTopicExplanation = new Map();

    for (const node of topicNodesResult.rows) {
      const nodeId = String(node.id);
      const unitLibraryId = unitLibraryByUnitNodeId.get(String(node.parent_id ?? ""));
      if (!unitLibraryId) {
        report.topicNodesUnmapped += 1;
        continue;
      }

      const normalizedTitle = normalizeTitle(node.title);
      let canonicalTopicId = normalizedTitle
        ? unitTopicIdByKey.get(`${unitLibraryId}|${normalizedTitle}`)
        : null;

      if (!canonicalTopicId) {
        const fallbackTopic = chooseBySortOrder(unitTopicsByUnit.get(unitLibraryId), node.sort_order);
        canonicalTopicId = fallbackTopic?.id ?? null;
      }

      if (!canonicalTopicId) {
        report.topicNodesUnmapped += 1;
        continue;
      }

      await client.query(
        `UPDATE public.nodes SET unit_topic_id = $1 WHERE id = $2`,
        [canonicalTopicId, nodeId],
      );
      report.topicNodesMapped += 1;
      canonicalTopicByTopicNodeId.set(nodeId, canonicalTopicId);

      const explanation = String(node.explanation ?? "").trim();
      if (explanation) {
        const prev = bestTopicExplanation.get(canonicalTopicId) || "";
        if (!prev || explanation.length > prev.length) {
          bestTopicExplanation.set(canonicalTopicId, explanation);
        }
      }
    }

    for (const [topicId, explanation] of bestTopicExplanation.entries()) {
      const update = await client.query(
        `
        UPDATE public.unit_topics
        SET explanation = CASE
          WHEN explanation IS NULL OR btrim(explanation) = '' OR char_length(explanation) < char_length($2)
            THEN $2
          ELSE explanation
        END,
        updated_at = now()
        WHERE id = $1
        RETURNING id
        `,
        [topicId, explanation],
      );
      if (update.rowCount > 0) report.topicExplanationsUpdated += 1;
    }

    const subtopicNodesResult = await client.query(`
      SELECT id, parent_id, title, sort_order
      FROM public.nodes
      WHERE type = 'subtopic'
    `);
    const canonicalSubtopicByNodeId = new Map();

    for (const node of subtopicNodesResult.rows) {
      const nodeId = String(node.id);
      const topicId = canonicalTopicByTopicNodeId.get(String(node.parent_id ?? ""));
      if (!topicId) {
        report.subtopicNodesUnmapped += 1;
        continue;
      }

      const normalizedTitle = normalizeTitle(node.title);
      let canonicalSubtopicId = normalizedTitle
        ? unitSubtopicIdByKey.get(`${topicId}|${normalizedTitle}`)
        : null;

      if (!canonicalSubtopicId) {
        const fallbackSubtopic = chooseBySortOrder(unitSubtopicsByTopic.get(topicId), node.sort_order);
        canonicalSubtopicId = fallbackSubtopic?.id ?? null;
      }

      if (!canonicalSubtopicId) {
        report.subtopicNodesUnmapped += 1;
        continue;
      }

      await client.query(
        `UPDATE public.nodes SET unit_subtopic_id = $1 WHERE id = $2`,
        [canonicalSubtopicId, nodeId],
      );
      report.subtopicNodesMapped += 1;
      canonicalSubtopicByNodeId.set(nodeId, canonicalSubtopicId);
    }

    const subtopicContentResult = await client.query(`
      SELECT sc.node_id, sc.explanation
      FROM public.subtopic_contents sc
    `);
    const bestSubtopicExplanation = new Map();
    for (const row of subtopicContentResult.rows) {
      const subtopicId = canonicalSubtopicByNodeId.get(String(row.node_id));
      if (!subtopicId) continue;
      const explanation = String(row.explanation ?? "").trim();
      if (!explanation) continue;
      const prev = bestSubtopicExplanation.get(subtopicId) || "";
      if (!prev || explanation.length > prev.length) {
        bestSubtopicExplanation.set(subtopicId, explanation);
      }
    }

    for (const [subtopicId, explanation] of bestSubtopicExplanation.entries()) {
      const update = await client.query(
        `
        UPDATE public.unit_subtopics
        SET explanation = CASE
          WHEN explanation IS NULL OR btrim(explanation) = '' OR char_length(explanation) < char_length($2)
            THEN $2
          ELSE explanation
        END,
        updated_at = now()
        WHERE id = $1
        RETURNING id
        `,
        [subtopicId, explanation],
      );
      if (update.rowCount > 0) report.subtopicExplanationsUpdated += 1;
    }

    const questionsMappedResult = await client.query(`
      SELECT
        sq.id AS legacy_question_id,
        sq.node_id AS legacy_node_id,
        sq.mark_type,
        sq.question,
        sq.answer,
        sq.is_starred,
        sq.star_source,
        n.config_id,
        n.unit_subtopic_id
      FROM public.subtopic_questions sq
      JOIN public.nodes n ON n.id = sq.node_id
      WHERE n.unit_subtopic_id IS NOT NULL
      ORDER BY sq.id ASC
    `);

    for (const row of questionsMappedResult.rows) {
      await client.query(
        `
        INSERT INTO public.config_questions (
          config_id,
          unit_subtopic_id,
          mark_type,
          question,
          answer,
          is_starred,
          star_source,
          legacy_node_id,
          legacy_question_id
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (legacy_question_id)
        DO UPDATE SET
          config_id = EXCLUDED.config_id,
          unit_subtopic_id = EXCLUDED.unit_subtopic_id,
          mark_type = EXCLUDED.mark_type,
          question = EXCLUDED.question,
          answer = EXCLUDED.answer,
          is_starred = EXCLUDED.is_starred,
          star_source = EXCLUDED.star_source,
          legacy_node_id = EXCLUDED.legacy_node_id,
          updated_at = now()
        `,
        [
          row.config_id,
          row.unit_subtopic_id,
          row.mark_type,
          row.question,
          row.answer,
          row.is_starred ?? false,
          row.star_source ?? "none",
          row.legacy_node_id,
          row.legacy_question_id,
        ],
      );
      report.configQuestionsUpserted += 1;
    }

    const unmappedQuestions = await client.query(`
      SELECT COUNT(*)::bigint AS c
      FROM public.subtopic_questions sq
      LEFT JOIN public.nodes n ON n.id = sq.node_id
      WHERE n.unit_subtopic_id IS NULL
    `);
    report.configQuestionsUnmapped = Number(unmappedQuestions.rows[0]?.c ?? 0);

    await client.query("COMMIT");
    console.log("Content model refactor complete (test DB).");
    console.log(JSON.stringify(report, null, 2));
    console.log(`Elapsed: ${((Date.now() - startedAt) / 1000).toFixed(2)}s`);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    if (error && typeof error === "object") {
      console.error("Refactor failed:", {
        message: error.message,
        code: error.code,
        detail: error.detail,
        hint: error.hint,
      });
    } else {
      console.error("Refactor failed:", String(error));
    }
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
