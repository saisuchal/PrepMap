BEGIN;

ALTER TABLE IF EXISTS public.config_unit_links
  ALTER COLUMN sort_order TYPE integer
  USING COALESCE(NULLIF(trim(sort_order::text), ''), '0')::integer;

ALTER TABLE IF EXISTS public.canonical_nodes
  ALTER COLUMN sort_order TYPE integer
  USING COALESCE(NULLIF(trim(sort_order::text), ''), '0')::integer;

ALTER TABLE IF EXISTS public.nodes
  ALTER COLUMN sort_order TYPE integer
  USING COALESCE(NULLIF(trim(sort_order::text), ''), '0')::integer;

ALTER TABLE IF EXISTS public.config_questions
  DROP COLUMN IF EXISTS legacy_node_id;

ALTER TABLE IF EXISTS public.config_questions
  DROP COLUMN IF EXISTS legacy_question_id;

COMMIT;
