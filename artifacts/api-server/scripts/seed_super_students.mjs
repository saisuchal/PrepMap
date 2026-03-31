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

const sqlPath = path.resolve(process.cwd(), "scripts/seed_super_students.sql");
if (!fs.existsSync(sqlPath)) {
  console.error(`Seed file not found: ${sqlPath}`);
  process.exit(1);
}

const sql = fs.readFileSync(sqlPath, "utf8");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  await pool.query(sql);
  console.log("Super students seeded successfully.");
} catch (error) {
  console.error("Failed to seed super students:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
