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
    ALTER TABLE IF EXISTS public.users
    ADD COLUMN IF NOT EXISTS created_at timestamp without time zone NOT NULL DEFAULT now();
  `);

  await pool.query(`
    ALTER TABLE IF EXISTS public.users
    ADD COLUMN IF NOT EXISTS updated_at timestamp without time zone NOT NULL DEFAULT now();
  `);

  await pool.query(`
    ALTER TABLE IF EXISTS public.universities
    ADD COLUMN IF NOT EXISTS updated_at timestamp without time zone NOT NULL DEFAULT now();
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
    CREATE TABLE IF NOT EXISTS public.config_unit_links (
      id text PRIMARY KEY,
      config_id text NOT NULL,
      unit_library_id text NOT NULL,
      sort_order integer NOT NULL DEFAULT 0,
      created_at timestamp without time zone NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    ALTER TABLE IF EXISTS public.config_unit_links
    ADD COLUMN IF NOT EXISTS updated_at timestamp without time zone NOT NULL DEFAULT now();
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS config_unit_links_unique
    ON public.config_unit_links (config_id, unit_library_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.canonical_nodes (
      id text PRIMARY KEY,
      subject_id text NOT NULL,
      unit_library_id text NOT NULL,
      title text NOT NULL,
      normalized_title text,
      type text NOT NULL,
      parent_canonical_node_id text,
      explanation text,
      learning_goal text,
      example_block text,
      support_note text,
      prerequisite_titles text,
      prerequisite_node_ids text,
      next_recommended_titles text,
      next_recommended_node_ids text,
      sort_order integer NOT NULL DEFAULT 0,
      created_at timestamp without time zone NOT NULL DEFAULT now(),
      updated_at timestamp without time zone NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS canonical_nodes_subject_idx
    ON public.canonical_nodes (subject_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS canonical_nodes_unit_idx
    ON public.canonical_nodes (unit_library_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS canonical_nodes_parent_idx
    ON public.canonical_nodes (parent_canonical_node_id);
  `);

  await pool.query(`
    ALTER TABLE IF EXISTS public.canonical_nodes
    ADD COLUMN IF NOT EXISTS normalized_title text;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS canonical_nodes_subject_norm_title_idx
    ON public.canonical_nodes (subject_id, normalized_title);
  `);

  await pool.query(`
    UPDATE public.canonical_nodes
    SET normalized_title = regexp_replace(lower(trim(title)), '[^a-z0-9\\s]+', ' ', 'g')
    WHERE normalized_title IS NULL OR btrim(normalized_title) = '';
  `);

  await pool.query(`
    ALTER TABLE public.nodes
    ADD COLUMN IF NOT EXISTS canonical_node_id text;
  `);

  await pool.query(`
    ALTER TABLE IF EXISTS public.nodes
    ADD COLUMN IF NOT EXISTS normalized_title text;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS nodes_config_norm_title_idx
    ON public.nodes (config_id, normalized_title);
  `);

  await pool.query(`
    UPDATE public.nodes
    SET normalized_title = regexp_replace(lower(trim(title)), '[^a-z0-9\\s]+', ' ', 'g')
    WHERE normalized_title IS NULL OR btrim(normalized_title) = '';
  `);

  await pool.query(`
    ALTER TABLE IF EXISTS public.nodes
    ADD COLUMN IF NOT EXISTS created_at timestamp without time zone NOT NULL DEFAULT now();
  `);

  await pool.query(`
    ALTER TABLE IF EXISTS public.nodes
    ADD COLUMN IF NOT EXISTS updated_at timestamp without time zone NOT NULL DEFAULT now();
  `);

  await pool.query(`
    ALTER TABLE IF EXISTS public.configs
    ADD COLUMN IF NOT EXISTS updated_at timestamp without time zone NOT NULL DEFAULT now();
  `);

  await pool.query(`
    ALTER TABLE IF EXISTS public.events
    ADD COLUMN IF NOT EXISTS created_at timestamp without time zone NOT NULL DEFAULT now();
  `);

  await pool.query(`
    ALTER TABLE IF EXISTS public.events
    ADD COLUMN IF NOT EXISTS updated_at timestamp without time zone NOT NULL DEFAULT now();
  `);

  await pool.query(`
    ALTER TABLE IF EXISTS public.events
    ADD COLUMN IF NOT EXISTS question_id text;
  `);

  await pool.query(`
    ALTER TABLE IF EXISTS public.events
    ALTER COLUMN topic_id DROP NOT NULL,
    ALTER COLUMN subtopic_id DROP NOT NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS events_question_idx
    ON public.events (question_id);
  `);

  // Legacy tables (subtopic_contents, subtopic_questions) are intentionally
  // not created/managed here. The app uses canonical/config-scoped tables.

  await pool.query(`
    ALTER TABLE public.nodes
    ADD COLUMN IF NOT EXISTS subject_id text;
  `);

  await pool.query(`
    ALTER TABLE public.nodes
    ADD COLUMN IF NOT EXISTS unit_library_id text;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS nodes_config_canonical_idx
    ON public.nodes (config_id, canonical_node_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS nodes_subject_idx
    ON public.nodes (subject_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS nodes_unit_library_idx
    ON public.nodes (unit_library_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.config_questions (
      id bigserial PRIMARY KEY,
      config_id text NOT NULL,
      unit_subtopic_id text,
      mark_type text NOT NULL,
      question text NOT NULL,
      answer text NOT NULL,
      is_starred boolean NOT NULL DEFAULT false,
      star_source text NOT NULL DEFAULT 'none',
      created_at timestamp without time zone NOT NULL DEFAULT now(),
      updated_at timestamp without time zone NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.config_replica_questions (
      id bigserial PRIMARY KEY,
      config_id text NOT NULL,
      mark_type text NOT NULL,
      question text NOT NULL,
      answer text NOT NULL,
      unit_title text,
      topic_title text,
      subtopic_title text,
      is_starred boolean NOT NULL DEFAULT true,
      sort_order integer NOT NULL DEFAULT 0,
      created_at timestamp without time zone NOT NULL DEFAULT now(),
      updated_at timestamp without time zone NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    ALTER TABLE IF EXISTS public.config_replica_questions
    ALTER COLUMN unit_title DROP NOT NULL,
    ALTER COLUMN topic_title DROP NOT NULL,
    ALTER COLUMN subtopic_title DROP NOT NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS config_replica_questions_config_idx
    ON public.config_replica_questions (config_id);
  `);

  await pool.query(`
    ALTER TABLE IF EXISTS public.config_questions
    DROP COLUMN IF EXISTS legacy_node_id;
  `);

  await pool.query(`
    ALTER TABLE IF EXISTS public.config_questions
    DROP COLUMN IF EXISTS legacy_question_id;
  `);

  await pool.query(`
    ALTER TABLE IF EXISTS public.config_questions
    ALTER COLUMN unit_subtopic_id DROP NOT NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS config_questions_config_idx
    ON public.config_questions (config_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS config_questions_subtopic_idx
    ON public.config_questions (unit_subtopic_id);
  `);

  // Migrate legacy scoped node ids in config_questions.unit_subtopic_id -> canonical subtopic ids.
  await pool.query(`
    UPDATE public.config_questions q
    SET unit_subtopic_id = n.unit_subtopic_id
    FROM public.nodes n
    WHERE n.config_id = q.config_id
      AND n.id = q.unit_subtopic_id
      AND n.unit_subtopic_id IS NOT NULL
      AND btrim(n.unit_subtopic_id) <> '';
  `);

  // Remove any legacy FK to dropped unit_subtopics table, then enforce canonical-node FK.
  await pool.query(`
    ALTER TABLE public.config_questions
    DROP CONSTRAINT IF EXISTS config_questions_unit_subtopic_id_fkey;
  `);

  await pool.query(`
    ALTER TABLE public.config_questions
    DROP CONSTRAINT IF EXISTS config_questions_unit_subtopic_id_canonical_fkey;
  `);

  await pool.query(`
    ALTER TABLE public.config_questions
    ADD CONSTRAINT config_questions_unit_subtopic_id_canonical_fkey
    FOREIGN KEY (unit_subtopic_id)
    REFERENCES public.canonical_nodes(id)
    NOT VALID;
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
    ALTER TABLE public.nodes
    ADD COLUMN IF NOT EXISTS learning_goal text;
  `);

  await pool.query(`
    ALTER TABLE public.nodes
    ADD COLUMN IF NOT EXISTS example_block text;
  `);

  await pool.query(`
    ALTER TABLE public.nodes
    ADD COLUMN IF NOT EXISTS support_note text;
  `);

  await pool.query(`
    ALTER TABLE public.nodes
    ADD COLUMN IF NOT EXISTS prerequisite_titles text;
  `);

  await pool.query(`
    ALTER TABLE public.nodes
    ADD COLUMN IF NOT EXISTS prerequisite_node_ids text;
  `);

  await pool.query(`
    ALTER TABLE public.nodes
    ADD COLUMN IF NOT EXISTS next_recommended_titles text;
  `);

  await pool.query(`
    ALTER TABLE public.nodes
    ADD COLUMN IF NOT EXISTS next_recommended_node_ids text;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS nodes_config_unit_topic_idx
    ON public.nodes (config_id, unit_topic_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS nodes_config_unit_subtopic_idx
    ON public.nodes (config_id, unit_subtopic_id);
  `);

  // Normalize legacy sort_order columns to integer safely.
  for (const tableName of ["config_unit_links", "canonical_nodes", "nodes"] as const) {
    await pool.query(`
      ALTER TABLE IF EXISTS public.${tableName}
      ALTER COLUMN sort_order DROP DEFAULT;
    `);
    await pool.query(`
      ALTER TABLE IF EXISTS public.${tableName}
      ALTER COLUMN sort_order TYPE integer
      USING COALESCE(NULLIF(trim(sort_order::text), ''), '0')::integer;
    `);
    await pool.query(`
      ALTER TABLE IF EXISTS public.${tableName}
      ALTER COLUMN sort_order SET DEFAULT 0;
    `);
  }

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
