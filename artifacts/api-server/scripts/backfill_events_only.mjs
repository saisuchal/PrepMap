#!/usr/bin/env node
import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

const sourceUrl = process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL || process.argv[2];
const targetUrl = process.env.TARGET_DATABASE_URL || process.argv[3];
const batchSize = Math.max(1, Number(process.env.COPY_BATCH_SIZE || 1000));

if (!sourceUrl || !targetUrl) {
  console.error("Usage:");
  console.error("  DATABASE_URL=<old> TARGET_DATABASE_URL=<new> node scripts/backfill_events_only.mjs");
  console.error("or");
  console.error("  SOURCE_DATABASE_URL=<old> TARGET_DATABASE_URL=<new> node scripts/backfill_events_only.mjs");
  console.error("or");
  console.error("  node scripts/backfill_events_only.mjs <old_database_url> <new_database_url>");
  process.exit(1);
}

const ssl = { rejectUnauthorized: false };
const source = new Pool({ connectionString: sourceUrl, ssl });
const target = new Pool({ connectionString: targetUrl, ssl });

const EVENT_COLS_WITH_ID = [
  "id",
  "user_id",
  "university_id",
  "year",
  "branch",
  "exam",
  "config_id",
  "topic_id",
  "subtopic_id",
  "question_id",
  "timestamp",
  "created_at",
  "updated_at",
];

const EVENT_COLS_NO_ID = EVENT_COLS_WITH_ID.filter((c) => c !== "id");

const quote = (name) => `"${String(name).replace(/"/g, "\"\"")}"`;

function buildInsertSql(columns, rowCount) {
  const colSql = columns.map((c) => quote(c)).join(", ");
  const valuesSql = Array.from({ length: rowCount }, (_, rowIdx) => {
    const placeholders = columns.map((_, colIdx) => `$${rowIdx * columns.length + colIdx + 1}`);
    return `(${placeholders.join(", ")})`;
  }).join(", ");
  return `INSERT INTO public.events (${colSql}) VALUES ${valuesSql}`;
}

function buildTupleValues(rows, includeId = false) {
  const cols = includeId ? EVENT_COLS_WITH_ID : EVENT_COLS_NO_ID;
  const values = [];
  for (const row of rows) {
    for (const col of cols) {
      values.push(row[col] ?? null);
    }
  }
  return values;
}

function hasSameFingerprint(row, existingSet) {
  const fp = JSON.stringify([
    row.user_id ?? null,
    row.university_id ?? null,
    row.year ?? null,
    row.branch ?? null,
    row.exam ?? null,
    row.config_id ?? null,
    row.topic_id ?? null,
    row.subtopic_id ?? null,
    row.question_id ?? null,
    row.timestamp ? new Date(row.timestamp).toISOString() : null,
  ]);
  return existingSet.has(fp);
}

async function fetchExistingFingerprints(targetClient, rows) {
  if (rows.length === 0) return new Set();
  const cols = [
    "user_id",
    "university_id",
    "year",
    "branch",
    "exam",
    "config_id",
    "topic_id",
    "subtopic_id",
    "question_id",
    "timestamp",
  ];

  const tupleSql = Array.from({ length: rows.length }, (_, rowIdx) => {
    const ph = cols.map((_, colIdx) => `$${rowIdx * cols.length + colIdx + 1}`);
    return `(${ph.join(", ")})`;
  }).join(", ");

  const values = [];
  for (const row of rows) {
    values.push(
      row.user_id ?? null,
      row.university_id ?? null,
      row.year ?? null,
      row.branch ?? null,
      row.exam ?? null,
      row.config_id ?? null,
      row.topic_id ?? null,
      row.subtopic_id ?? null,
      row.question_id ?? null,
      row.timestamp ?? null,
    );
  }

  const sql = `
    WITH src_raw (
      user_id,
      university_id,
      year,
      branch,
      exam,
      config_id,
      topic_id,
      subtopic_id,
      question_id,
      ts_raw
    ) AS (
      VALUES ${tupleSql}
    ),
    src (
      user_id,
      university_id,
      year,
      branch,
      exam,
      config_id,
      topic_id,
      subtopic_id,
      question_id,
      timestamp
    ) AS (
      SELECT
        user_id,
        university_id,
        year,
        branch,
        exam,
        config_id,
        topic_id,
        subtopic_id,
        question_id,
        ts_raw::timestamp without time zone
      FROM src_raw
    )
    SELECT
      e.user_id,
      e.university_id,
      e.year,
      e.branch,
      e.exam,
      e.config_id,
      e.topic_id,
      e.subtopic_id,
      e.question_id,
      e.timestamp
    FROM public.events e
    JOIN src s
      ON e.user_id = s.user_id
     AND e.university_id = s.university_id
     AND e.year = s.year
     AND e.branch = s.branch
     AND e.exam = s.exam
     AND e.config_id = s.config_id
     AND e.topic_id IS NOT DISTINCT FROM s.topic_id
     AND e.subtopic_id IS NOT DISTINCT FROM s.subtopic_id
     AND e.question_id IS NOT DISTINCT FROM s.question_id
     AND e.timestamp = s.timestamp
  `;

  const { rows: existing } = await targetClient.query(sql, values);
  const set = new Set();
  for (const row of existing) {
    set.add(
      JSON.stringify([
        row.user_id ?? null,
        row.university_id ?? null,
        row.year ?? null,
        row.branch ?? null,
        row.exam ?? null,
        row.config_id ?? null,
        row.topic_id ?? null,
        row.subtopic_id ?? null,
        row.question_id ?? null,
        row.timestamp ? new Date(row.timestamp).toISOString() : null,
      ]),
    );
  }
  return set;
}

async function resetEventsSequence(targetClient) {
  await targetClient.query(`
    SELECT setval(
      pg_get_serial_sequence('public.events', 'id'),
      COALESCE((SELECT MAX(id) FROM public.events), 0) + 1,
      false
    )
  `);
}

async function run() {
  const startedAt = Date.now();
  let insertedWithId = 0;
  let insertedWithoutId = 0;
  let skippedExisting = 0;

  try {
    const [sourceCountRes, targetCountRes] = await Promise.all([
      source.query("SELECT COUNT(*)::bigint AS count FROM public.events"),
      target.query("SELECT COUNT(*)::bigint AS count FROM public.events"),
    ]);
    const sourceCount = Number(sourceCountRes.rows[0]?.count ?? 0);
    const targetCountBefore = Number(targetCountRes.rows[0]?.count ?? 0);

    console.log(`Source events: ${sourceCount}`);
    console.log(`Target events (before): ${targetCountBefore}`);

    let offset = 0;
    while (true) {
      const { rows: batch } = await source.query(
        `
        SELECT ${EVENT_COLS_WITH_ID.map((c) => quote(c)).join(", ")}
        FROM public.events
        ORDER BY id ASC
        LIMIT $1 OFFSET $2
        `,
        [batchSize, offset],
      );
      if (batch.length === 0) break;

      const fingerprintSet = await fetchExistingFingerprints(target, batch);
      const sourceIds = batch.map((r) => r.id).filter((v) => v !== null && v !== undefined);

      const existingIds = new Set();
      if (sourceIds.length > 0) {
        const { rows: existingIdRows } = await target.query(
          `SELECT id FROM public.events WHERE id = ANY($1::int[])`,
          [sourceIds],
        );
        for (const r of existingIdRows) existingIds.add(Number(r.id));
      }

      const toInsertWithId = [];
      const toInsertWithoutId = [];
      for (const row of batch) {
        if (hasSameFingerprint(row, fingerprintSet)) {
          skippedExisting += 1;
          continue;
        }
        if (row.id !== null && row.id !== undefined && !existingIds.has(Number(row.id))) {
          toInsertWithId.push(row);
        } else {
          toInsertWithoutId.push(row);
        }
      }

      if (toInsertWithId.length > 0) {
        const sql = buildInsertSql(EVENT_COLS_WITH_ID, toInsertWithId.length);
        const vals = buildTupleValues(toInsertWithId, true);
        await target.query(sql, vals);
        insertedWithId += toInsertWithId.length;
      }

      if (toInsertWithoutId.length > 0) {
        const sql = buildInsertSql(EVENT_COLS_NO_ID, toInsertWithoutId.length);
        const vals = buildTupleValues(toInsertWithoutId, false);
        await target.query(sql, vals);
        insertedWithoutId += toInsertWithoutId.length;
      }

      offset += batch.length;
      console.log(
        `Processed ${Math.min(offset, sourceCount)}/${sourceCount} | inserted(with id): ${insertedWithId} | inserted(no id): ${insertedWithoutId} | skipped: ${skippedExisting}`,
      );
    }

    await resetEventsSequence(target);

    const { rows: afterRows } = await target.query("SELECT COUNT(*)::bigint AS count FROM public.events");
    const targetCountAfter = Number(afterRows[0]?.count ?? 0);

    console.log("\nEvents backfill complete.");
    console.log(`Inserted with source id: ${insertedWithId}`);
    console.log(`Inserted without id (id-collision safe): ${insertedWithoutId}`);
    console.log(`Skipped already-existing: ${skippedExisting}`);
    console.log(`Target events (after): ${targetCountAfter}`);
    console.log(`Elapsed: ${((Date.now() - startedAt) / 1000).toFixed(2)}s`);
  } catch (error) {
    if (error && typeof error === "object") {
      console.error("Events backfill failed:", {
        message: error.message,
        code: error.code,
        detail: error.detail,
        hint: error.hint,
        stack: error.stack,
      });
    } else {
      console.error("Events backfill failed:", String(error));
    }
    process.exitCode = 1;
  } finally {
    await source.end();
    await target.end();
  }
}

run();
