-- Seed script: super students for cross-config QA in each university.
-- Uses role = 'super_student' (no admin access).

BEGIN;

INSERT INTO public.users (id, university_id, branch, year, role, password)
VALUES
  ('test-adypu', 'uni9', 'CSE', '1', 'super_student', '$2b$10$gcmTDjV2J6L4phYLHznjFOQhRhcPXlmU4kN3ZXxDA4vTTNr6Ph4iO'),
  ('test-amet', 'uni13', 'CSE', '1', 'super_student', '$2b$10$gcmTDjV2J6L4phYLHznjFOQhRhcPXlmU4kN3ZXxDA4vTTNr6Ph4iO'),
  ('test-annamacharya', 'uni16', 'CSE', '1', 'super_student', '$2b$10$gcmTDjV2J6L4phYLHznjFOQhRhcPXlmU4kN3ZXxDA4vTTNr6Ph4iO'),
  ('test-aurora', 'uni8', 'CSE', '1', 'super_student', '$2b$10$gcmTDjV2J6L4phYLHznjFOQhRhcPXlmU4kN3ZXxDA4vTTNr6Ph4iO'),
  ('test-bits-hyd', 'uni6', 'CSE', '1', 'super_student', '$2b$10$gcmTDjV2J6L4phYLHznjFOQhRhcPXlmU4kN3ZXxDA4vTTNr6Ph4iO'),
  ('test-cdu', 'uni1', 'CSE', '1', 'super_student', '$2b$10$gcmTDjV2J6L4phYLHznjFOQhRhcPXlmU4kN3ZXxDA4vTTNr6Ph4iO'),
  ('test-ciet', 'uni7', 'CSE', '1', 'super_student', '$2b$10$gcmTDjV2J6L4phYLHznjFOQhRhcPXlmU4kN3ZXxDA4vTTNr6Ph4iO'),
  ('test-crescent', 'uni14', 'CSE', '1', 'super_student', '$2b$10$gcmTDjV2J6L4phYLHznjFOQhRhcPXlmU4kN3ZXxDA4vTTNr6Ph4iO'),
  ('test-mrv', 'uni3', 'CSE', '1', 'super_student', '$2b$10$gcmTDjV2J6L4phYLHznjFOQhRhcPXlmU4kN3ZXxDA4vTTNr6Ph4iO'),
  ('test-niu', 'uni11', 'CSE', '1', 'super_student', '$2b$10$gcmTDjV2J6L4phYLHznjFOQhRhcPXlmU4kN3ZXxDA4vTTNr6Ph4iO'),
  ('test-nriit', 'uni2', 'CSE', '1', 'super_student', '$2b$10$gcmTDjV2J6L4phYLHznjFOQhRhcPXlmU4kN3ZXxDA4vTTNr6Ph4iO'),
  ('test-nsrit', 'uni4', 'CSE', '1', 'super_student', '$2b$10$gcmTDjV2J6L4phYLHznjFOQhRhcPXlmU4kN3ZXxDA4vTTNr6Ph4iO'),
  ('test-s-vyasa', 'uni12', 'CSE', '1', 'super_student', '$2b$10$gcmTDjV2J6L4phYLHznjFOQhRhcPXlmU4kN3ZXxDA4vTTNr6Ph4iO'),
  ('test-sgu', 'uni15', 'CSE', '1', 'super_student', '$2b$10$gcmTDjV2J6L4phYLHznjFOQhRhcPXlmU4kN3ZXxDA4vTTNr6Ph4iO'),
  ('test-takshashila', 'uni5', 'CSE', '1', 'super_student', '$2b$10$gcmTDjV2J6L4phYLHznjFOQhRhcPXlmU4kN3ZXxDA4vTTNr6Ph4iO'),
  ('test-vgu', 'uni10', 'CSE', '1', 'super_student', '$2b$10$gcmTDjV2J6L4phYLHznjFOQhRhcPXlmU4kN3ZXxDA4vTTNr6Ph4iO'),
  ('test-chalapathi', 'uni17', 'CSE', '1', 'super_student', '$2b$10$gcmTDjV2J6L4phYLHznjFOQhRhcPXlmU4kN3ZXxDA4vTTNr6Ph4iO'),
  ('test-yenepoya', 'uni18', 'CSE', '1', 'super_student', '$2b$10$gcmTDjV2J6L4phYLHznjFOQhRhcPXlmU4kN3ZXxDA4vTTNr6Ph4iO')
ON CONFLICT (id) DO UPDATE
SET
  university_id = EXCLUDED.university_id,
  branch = EXCLUDED.branch,
  year = EXCLUDED.year,
  role = EXCLUDED.role,
  password = EXCLUDED.password;

COMMIT;
