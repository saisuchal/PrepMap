import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required.");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  console.log("Dropping legacy content tables (if present)...");

  await pool.query(`
    DROP TABLE IF EXISTS public.subtopic_questions;
    DROP TABLE IF EXISTS public.subtopic_contents;
  `);

  console.log("Legacy tables dropped: subtopic_questions, subtopic_contents");
}

main()
  .catch((err) => {
    console.error("Failed to drop legacy tables:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

