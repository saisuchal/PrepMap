# PrepMap

PrepMap is an exam-readiness platform for universities.
It includes:
- an **Admin workflow** to create subject configs, upload syllabus/replica material, generate content, and publish live roadmaps.
- a **Student workflow** to view roadmaps, track progress, and surface adoption analytics.

## Monorepo Structure

- `artifacts/api-server` - Express + TypeScript backend (generation, auth, configs, analytics, uploads)
- `artifacts/exam-roadmap` - React + Vite frontend (admin + student UI)
- `api/[...path].ts` - Vercel function entry that mounts backend app
- `vercel.json` - Vercel build/runtime settings

## Core Product Flow

1. Admin creates a config (university, semester, exam, subject).
2. Admin can:
   - reuse units from the global reusable unit library,
   - extract units from pasted reading material,
   - edit units before generation.
3. Admin provides syllabus + one replica paper (paste text or upload image/pdf/txt).
4. Content generation creates/updates:
   - unit/topic/subtopic structure,
   - subtopic explanations,
   - question bank (exam-based targets: Mid = 50/20 starred, End Sem = 75/25 starred).
5. Admin previews, adjusts, and publishes config as `live`.
6. Students consume roadmap and events are tracked for analytics.

## Student Auth Onboarding

- Student initial password can be seeded as their college ID.
- On first login, student is forced to complete setup before accessing content:
  - set a new password
  - set security question + answer
- Forgot-password flow uses security question + answer validation.
- The platform stores:
  - `last_successful_login_at`
  - `last_password_reset_at`

### Bulk student import

Use TSV/CSV with columns in this order:
`student_id, student_name, university_name, university_id, semester`

Then run:

```bash
corepack pnpm --dir artifacts/api-server run import:students ./path/to/students.tsv CSE
```

Notes:
- Password is set to student ID (hashed).
- `must_reset_password = true` is enforced.
- Security question/answer are cleared, so first login setup is required.

### Student Data Loading (Header-Based TSV/CSV)

You can also import directly from a sheet export with headers like:

`id, university_id, branch, year, role, name, password, must_reset_password, security_question, security_answer_hash, ...`

Example row:

`N25B01A0001, uni13, CSE, 1, student, Abhay Murthy, , TRUE, ,`

Run:

```bash
corepack pnpm --dir artifacts/api-server run import:students "C:\path\students.tsv"
```

What the importer enforces during load:
- Password is always re-set to a bcrypt hash of `id` (temporary first-login password).
- `must_reset_password` is always set to `true`.
- `security_question` and `security_answer_hash` are cleared.
- Existing users with same `id` are upserted (updated).

## Generation Modes

### Expensive Mode
- Full in-portal generation using configured AI provider.
- Reuses existing explanations when available for matching subject/path.
- Generates fresh config-specific questions.

### Cheap Mode
- **Lane A**: build structure + extract replica mandatory questions + generate a master prompt.
- **Lane B**: generate bulk JSON externally, paste/import JSON back into PrepMap.
- Import pipeline validates, auto-fixes, enforces targets, and saves to DB/global library.

## Tech Stack

- Backend: Node.js, Express, TypeScript, Drizzle ORM, PostgreSQL
- Frontend: React, Vite, TypeScript, Tailwind, TanStack Query
- Storage: Supabase Storage (or compatible object storage pathing)
- AI: provider switch (`anthropic` or `openai`)

## Prerequisites

- Node.js 22 or 24 LTS
- pnpm (recommended via Corepack)
- PostgreSQL database (Supabase Postgres supported)

## Local Setup

1. Install deps

```bash
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm install
```

Windows note:
- `corepack enable` may require an Administrator terminal because it writes under `C:\Program Files\nodejs`.
- If you see `EPERM: operation not permitted, open 'C:\Program Files\nodejs\pnpm'`, open PowerShell as Administrator and run only:

```powershell
corepack enable
```

- Then continue in your normal terminal:

```bash
corepack prepare pnpm@10.33.0 --activate
pnpm install
pnpm run dev
```

2. Configure backend env

Copy and fill:
- `artifacts/api-server/.env.example` -> `artifacts/api-server/.env`

Key required values:
- `DATABASE_URL`
- `PORT=4000`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_STORAGE_BUCKET`
- AI settings (`AI_PROVIDER`, provider API key)

3. Configure frontend env (optional overrides)

Copy and fill:
- `artifacts/exam-roadmap/.env.example` -> `artifacts/exam-roadmap/.env`

4. Run app

```bash
pnpm run dev
```

This starts:
- API on `http://localhost:4000`
- Web on `http://localhost:5173`

## Build Commands

```bash
pnpm run build
pnpm run typecheck
```

For Vercel web build output:

```bash
pnpm run build:vercel
```

## Deployment (Vercel)

The repository is already configured with:
- `vercel.json` build command and output directory
- Node runtime for API functions
- `api/[...path].ts` forwarding to backend Express app

Set environment variables in Vercel matching backend `.env` requirements.

## Important Environment Variables (Backend)

- `DATABASE_URL`
- `PORT`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_STORAGE_BUCKET`
- `AI_PROVIDER` = `anthropic` or `openai`
- `AI_MODEL` (optional; provider default applies)
- `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
- `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` (optional)
- `LOW_QUOTA_MODE`
- `QUESTION_BATCH_SIZE`
- `QUESTION_MIN_BATCH_SIZE`
- `AI_REQUEST_INTERVAL_MS`

Question/star targets are exam-based in code:
- `mid1`/`mid2` -> `50` questions, `20` starred
- `endsem` -> `75` questions, `25` starred

## Notes on Data Design

- Config content is **config-specific** for safety.
- Reusable unit library is **global** and used for structural reuse.
- Explanations can be reused where applicable; question banks are regenerated per config.
- Analytics aggregate student events to config and university adoption views.
- Config "delete" is treated as **disable** (content is preserved; config is hidden from normal active lists).
- Admin can open student roadmap preview, but admin interactions are excluded from tracking analytics.

## Student Rating System (Admin Analytics)

In **Admin -> Analytics -> Student Progress** (inside a selected live config), each student is assigned a rating using:
- sub-topic coverage % (from tracked roadmap progress)
- QB interaction % (question-bank interactions / total questions in that config)

Rules:
- **Poor**: sub-topic coverage `<= 30%` **or** QB interaction `<= 50%`
- **Average**: sub-topic coverage `>= 50%` **and** QB interaction `>= 50%`
- **Good**: sub-topic coverage `>= 75%` **and** QB interaction `>= 75%`

The config-level summary shows both:
- count per rating
- percentage per rating (based on total students in that config)

## Security

- Never commit real API keys/service-role keys.
- Rotate any key that was ever exposed in logs, screenshots, or commits.

## Troubleshooting

- DB timeout/auth errors: verify `DATABASE_URL` and pooler credentials.
- Upload URL errors: verify Supabase vars and bucket existence.
- AI JSON parse errors: reduce batch sizes and/or enable `LOW_QUOTA_MODE=true`.
- Windows `corepack enable` `EPERM`: run `corepack enable` once in Administrator PowerShell, then continue in normal terminal.
