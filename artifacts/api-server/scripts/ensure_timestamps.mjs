import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: ".env" });

const { Client } = pg;

const TABLES = [
  "users",
  "universities",
  "subjects",
  "unit_library",
  "unit_topics",
  "unit_subtopics",
  "canonical_nodes",
  "config_unit_links",
  "configs",
  "nodes",
  "config_questions",
  "events",
];

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    for (const table of TABLES) {
      await client.query(`
        ALTER TABLE IF EXISTS public.${table}
        ADD COLUMN IF NOT EXISTS created_at timestamp without time zone NOT NULL DEFAULT now();
      `);
      await client.query(`
        ALTER TABLE IF EXISTS public.${table}
        ADD COLUMN IF NOT EXISTS updated_at timestamp without time zone NOT NULL DEFAULT now();
      `);
    }

    const result = await client.query(
      `
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
        AND column_name IN ('created_at', 'updated_at')
      ORDER BY table_name, column_name
      `,
      [TABLES],
    );

    const byTable = new Map();
    for (const row of result.rows) {
      if (!byTable.has(row.table_name)) byTable.set(row.table_name, new Set());
      byTable.get(row.table_name).add(row.column_name);
    }

    const missing = [];
    for (const table of TABLES) {
      const cols = byTable.get(table) ?? new Set();
      if (!cols.has("created_at") || !cols.has("updated_at")) {
        missing.push({
          table,
          hasCreatedAt: cols.has("created_at"),
          hasUpdatedAt: cols.has("updated_at"),
        });
      }
    }

    if (missing.length > 0) {
      console.log("Timestamp check incomplete:", JSON.stringify(missing, null, 2));
      process.exitCode = 1;
      return;
    }

    console.log("Timestamp check passed for all target tables.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
