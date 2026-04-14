import dotenv from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { DEFAULT_UNIVERSITIES } from "../lib/appMetadata";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envCandidates = [
  path.resolve(process.cwd(), "artifacts/api-server/.env"),
  path.resolve(process.cwd(), ".env"),
  path.resolve(__dirname, "../.env"),
];
const envPath = envCandidates.find((candidate) => fs.existsSync(candidate));
if (envPath) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

export * from "./schema";

export async function initializeDatabase(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.universities (
      id text PRIMARY KEY,
      name text NOT NULL,
      created_at timestamp without time zone NOT NULL DEFAULT now()
    );
  `);

  for (const u of DEFAULT_UNIVERSITIES) {
    await pool.query(
      `
      INSERT INTO public.universities (id, name)
      VALUES ($1, $2)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
      `,
      [u.id, u.name],
    );
  }

  await pool.query(`
    ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS name text;
  `);
  await pool.query(`
    ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS must_reset_password boolean NOT NULL DEFAULT false;
  `);
  await pool.query(`
    ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS security_question text;
  `);
  await pool.query(`
    ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS security_answer_hash text;
  `);
  await pool.query(`
    ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS last_successful_login_at timestamp without time zone;
  `);
  await pool.query(`
    ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS last_password_reset_at timestamp without time zone;
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'users'
          AND c.column_name = 'account_type'
      ) THEN
        EXECUTE '
          UPDATE public.users
          SET role = ''super_student''
          WHERE role = ''student'' AND account_type = ''super_student''
        ';
      END IF;
    END $$;
  `);

  await pool.query(`
    ALTER TABLE public.users
    DROP COLUMN IF EXISTS account_type;
  `);

  await pool.query(`
    ALTER TABLE public.events
    DROP COLUMN IF EXISTS account_type;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.subjects (
      id text PRIMARY KEY,
      name text NOT NULL,
      normalized_name text NOT NULL,
      created_by text NOT NULL,
      created_at timestamp without time zone NOT NULL DEFAULT now(),
      updated_at timestamp without time zone NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS subjects_normalized_name_unique
    ON public.subjects (normalized_name);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.unit_library (
      id text PRIMARY KEY,
      subject_id text NOT NULL,
      unit_title text NOT NULL,
      normalized_unit_title text NOT NULL,
      topics jsonb NOT NULL DEFAULT '[]'::jsonb,
      source_text text,
      created_by text NOT NULL,
      created_at timestamp without time zone NOT NULL DEFAULT now(),
      updated_at timestamp without time zone NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS unit_library_subject_unit_unique
    ON public.unit_library (subject_id, normalized_unit_title);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.subject_reading_materials (
      id text PRIMARY KEY,
      subject_id text NOT NULL,
      title text NOT NULL,
      material_type text NOT NULL DEFAULT 'reference',
      file_url text NOT NULL,
      source_order integer NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      created_by text NOT NULL,
      created_at timestamp without time zone NOT NULL DEFAULT now(),
      updated_at timestamp without time zone NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS subject_reading_materials_subject_active_idx
    ON public.subject_reading_materials (subject_id, is_active, source_order);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.config_unit_links (
      id text PRIMARY KEY,
      config_id text NOT NULL,
      unit_library_id text NOT NULL,
      sort_order text NOT NULL DEFAULT '0',
      created_at timestamp without time zone NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS config_unit_links_unique
    ON public.config_unit_links (config_id, unit_library_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.unit_topics (
      id text PRIMARY KEY,
      unit_library_id text NOT NULL,
      title text NOT NULL,
      normalized_title text NOT NULL,
      sort_order integer NOT NULL DEFAULT 0,
      explanation text,
      created_at timestamp without time zone NOT NULL DEFAULT now(),
      updated_at timestamp without time zone NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS unit_topics_unit_norm_unique
    ON public.unit_topics (unit_library_id, normalized_title);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS unit_topics_unit_sort_idx
    ON public.unit_topics (unit_library_id, sort_order);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.unit_subtopics (
      id text PRIMARY KEY,
      unit_topic_id text NOT NULL,
      title text NOT NULL,
      normalized_title text NOT NULL,
      sort_order integer NOT NULL DEFAULT 0,
      explanation text,
      created_at timestamp without time zone NOT NULL DEFAULT now(),
      updated_at timestamp without time zone NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS unit_subtopics_topic_norm_unique
    ON public.unit_subtopics (unit_topic_id, normalized_title);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS unit_subtopics_topic_sort_idx
    ON public.unit_subtopics (unit_topic_id, sort_order);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.config_questions (
      id bigserial PRIMARY KEY,
      config_id text NOT NULL,
      unit_subtopic_id text NOT NULL,
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

  await pool.query(`
    CREATE INDEX IF NOT EXISTS config_questions_config_idx
    ON public.config_questions (config_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS config_questions_subtopic_idx
    ON public.config_questions (unit_subtopic_id);
  `);

  await pool.query(`
    ALTER TABLE public.nodes
    ADD COLUMN IF NOT EXISTS unit_topic_id text;
  `);

  await pool.query(`
    ALTER TABLE public.nodes
    ADD COLUMN IF NOT EXISTS unit_subtopic_id text;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS nodes_config_unit_topic_idx
    ON public.nodes (config_id, unit_topic_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS nodes_config_unit_subtopic_idx
    ON public.nodes (config_id, unit_subtopic_id);
  `);

  const existingSubjects = await pool.query<{ subject: string }>(`
    SELECT DISTINCT subject
    FROM public.configs
    WHERE subject IS NOT NULL AND btrim(subject) <> '';
  `);

  for (const row of existingSubjects.rows) {
    const name = row.subject.trim();
    const normalized = name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    await pool.query(
      `
      INSERT INTO public.subjects (id, name, normalized_name, created_by)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (normalized_name) DO UPDATE
      SET name = EXCLUDED.name, updated_at = now()
      `,
      [`sub_${normalized.replace(/\s+/g, "_")}`, name, normalized, "system"],
    );
  }
}
