#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required in environment.");
  process.exit(1);
}

const timestamp = new Date()
  .toISOString()
  .replace(/[:.]/g, "-")
  .replace("T", "_")
  .replace("Z", "");

const outArg = process.argv[2] || `./exports/csv_${timestamp}`;
const outDir = path.resolve(process.cwd(), outArg);
fs.mkdirSync(outDir, { recursive: true });

const quoteIdent = (value) => `"${String(value).replace(/"/g, "\"\"")}"`;

const toCsvCell = (value) => {
  if (value === null || value === undefined) return "";
  const normalized =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
  if (/[",\r\n]/.test(normalized)) {
    return `"${normalized.replace(/"/g, "\"\"")}"`;
  }
  return normalized;
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  const { rows: tables } = await pool.query(
    `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name ASC
    `
  );

  if (tables.length === 0) {
    console.log("No tables found in public schema.");
    process.exit(0);
  }

  const summary = [];
  for (const t of tables) {
    const tableName = String(t.table_name);
    const sql = `SELECT * FROM ${quoteIdent("public")}.${quoteIdent(tableName)}`;
    const result = await pool.query(sql);
    const columns = result.fields.map((f) => f.name);

    const csvLines = [];
    csvLines.push(columns.map(toCsvCell).join(","));
    for (const row of result.rows) {
      csvLines.push(columns.map((c) => toCsvCell(row[c])).join(","));
    }

    const filePath = path.join(outDir, `${tableName}.csv`);
    fs.writeFileSync(filePath, `${csvLines.join("\n")}\n`, "utf8");
    summary.push({ table: tableName, rows: result.rows.length, filePath });
    console.log(`Exported ${tableName}: ${result.rows.length} rows`);
  }

  const summaryPath = path.join(outDir, "_summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify({ exportedAt: new Date().toISOString(), summary }, null, 2));

  console.log(`\nDone. CSV files written to:\n${outDir}`);
  console.log(`Summary:\n${summaryPath}`);
} finally {
  await pool.end();
}

