#!/usr/bin/env node
import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

const sourceUrl = process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL || process.argv[2];
const targetUrl = process.env.TARGET_DATABASE_URL || process.argv[3];
const batchSize = Math.max(1, Number(process.env.COPY_BATCH_SIZE || 1000));

if (!sourceUrl || !targetUrl) {
  console.error("Usage:");
  console.error("  DATABASE_URL=<old> TARGET_DATABASE_URL=<new> node scripts/replace_events_exact.mjs");
  console.error("or");
  console.error("  SOURCE_DATABASE_URL=<old> TARGET_DATABASE_URL=<new> node scripts/replace_events_exact.mjs");
  console.error("or");
  console.error("  node scripts/replace_events_exact.mjs <old_database_url> <new_database_url>");
  process.exit(1);
}

const ssl = { rejectUnauthorized: false };
const source = new Pool({ connectionString: sourceUrl, ssl });
const target = new Pool({ connectionString: targetUrl, ssl });

const columns = [
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

const quote = (name) => `"${String(name).replace(/"/g, "\"\"")}"`;

function buildInsertSql(rowCount) {
  const colSql = columns.map((c) => quote(c)).join(", ");
  const valuesSql = Array.from({ length: rowCount }, (_, rowIdx) => {
    const placeholders = columns.map((_, colIdx) => `$${rowIdx * columns.length + colIdx + 1}`);
    return `(${placeholders.join(", ")})`;
  }).join(", ");
  return `INSERT INTO public.events (${colSql}) VALUES ${valuesSql}`;
}

async function resetSequence(client) {
  await client.query(`
    SELECT setval(
      pg_get_serial_sequence('public.events', 'id'),
      COALESCE((SELECT MAX(id) FROM public.events), 0) + 1,
      false
    )
  `);
}

async function run() {
  const startedAt = Date.now();
  let inserted = 0;

  try {
    const [sourceCountRes, targetCountBeforeRes] = await Promise.all([
      source.query("SELECT COUNT(*)::bigint AS count FROM public.events"),
      target.query("SELECT COUNT(*)::bigint AS count FROM public.events"),
    ]);

    const sourceCount = Number(sourceCountRes.rows[0]?.count ?? 0);
    const targetCountBefore = Number(targetCountBeforeRes.rows[0]?.count ?? 0);

    console.log(`Source events: ${sourceCount}`);
    console.log(`Target events (before): ${targetCountBefore}`);

    await target.query("BEGIN");
    await target.query("TRUNCATE TABLE public.events RESTART IDENTITY");

    for (let offset = 0; offset < sourceCount; offset += batchSize) {
      const { rows } = await source.query(
        `
        SELECT ${columns.map((c) => quote(c)).join(", ")}
        FROM public.events
        ORDER BY id ASC
        LIMIT $1 OFFSET $2
        `,
        [batchSize, offset],
      );

      if (rows.length === 0) break;

      const insertSql = buildInsertSql(rows.length);
      const values = [];
      for (const row of rows) {
        for (const col of columns) {
          values.push(row[col] ?? null);
        }
      }
      await target.query(insertSql, values);
      inserted += rows.length;
      console.log(`Copied ${Math.min(inserted, sourceCount)}/${sourceCount}`);
    }

    await resetSequence(target);
    await target.query("COMMIT");

    const [targetCountAfterRes, sourceStatsRes, targetStatsRes] = await Promise.all([
      target.query("SELECT COUNT(*)::bigint AS count FROM public.events"),
      source.query(
        "SELECT MIN(id)::bigint AS min_id, MAX(id)::bigint AS max_id, MIN(timestamp) AS min_ts, MAX(timestamp) AS max_ts FROM public.events",
      ),
      target.query(
        "SELECT MIN(id)::bigint AS min_id, MAX(id)::bigint AS max_id, MIN(timestamp) AS min_ts, MAX(timestamp) AS max_ts FROM public.events",
      ),
    ]);

    const targetCountAfter = Number(targetCountAfterRes.rows[0]?.count ?? 0);
    const sourceStats = sourceStatsRes.rows[0] || {};
    const targetStats = targetStatsRes.rows[0] || {};

    console.log("\nExact events replacement complete.");
    console.log(`Inserted: ${inserted}`);
    console.log(`Target events (after): ${targetCountAfter}`);
    console.log("Source stats:", sourceStats);
    console.log("Target stats:", targetStats);
    console.log(`Elapsed: ${((Date.now() - startedAt) / 1000).toFixed(2)}s`);
  } catch (error) {
    try {
      await target.query("ROLLBACK");
    } catch {}
    if (error && typeof error === "object") {
      console.error("Exact replace failed:", {
        message: error.message,
        code: error.code,
        detail: error.detail,
        hint: error.hint,
        stack: error.stack,
      });
    } else {
      console.error("Exact replace failed:", String(error));
    }
    process.exitCode = 1;
  } finally {
    await source.end();
    await target.end();
  }
}

run();
