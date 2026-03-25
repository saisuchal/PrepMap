# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Frontend**: React + Vite + Tailwind CSS v4
- **Auth**: bcrypt password hashing (cost factor 10)

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   ├── api-server/         # Express API server
│   └── exam-roadmap/       # GP-Max Platform (React + Vite)
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/                # Utility scripts
│   └── src/
│       └── seed.ts         # Database seed script
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json
└── package.json
```

## Application: GP-Max (Exam Roadmap Platform)

A roadmap.sh-inspired last-minute exam prep platform for college students. Two roles: Admin (manages configs, content) and Student (navigates visual topic tree, reads Q&A, silently tracked).

Config = University + Branch + Year + Subject + Exam point (Mid-1, Mid-2, End Sem).

### Features

- **Login**: College ID + bcrypt-hashed password, role-based redirect (admin → /admin, student → /)
- **Password Reset**: Change password with current password verification
- **Config Selection**: University > Year > Branch > Subject cascading dropdowns, then 3 exam nodes (Mid-1, Mid-2, End Sem) with availability indicators (students see only "live" configs)
- **Visual Roadmap Tree**: Roadmap.sh-inspired visual mind-map with SVG connector lines, color-coded nodes (blue=units, violet=topics, green=subtopics), pannable/zoomable canvas with zoom controls
- **Content Modals**: Click topic node → modal with explanation. Click subtopic → modal with explanation + 2-mark/5-mark Q&A with reveal-answer toggles
- **Event Tracking**: IntersectionObserver-based tracking in subtopic modal (2s dwell at bottom of Q&A) fires SUBTOPIC_CONSUMED event, tracked per session via sessionStorage
- **Admin Dashboard**: Tabbed interface (Configs | Analytics) with config management, file upload, AI generation, publish flow, and content review
- **Admin Config Management**: Create configs, upload syllabus/papers (presigned URL flow), trigger AI generation with progress polling, publish to students, review generated content tree
- **Role-based routing**: Admin routes protected from students, student routes protected from admins

### Database Schema (Drizzle ORM)

- `users` — id (college_id), university_id, branch, year, role ("admin"/"student"), password (bcrypt hash)
- `configs` — id, university_id, year, branch, subject, exam, status ("draft"/"live"), created_by, syllabus_file_url, paper_file_urls, created_at
- `nodes` — id, config_id, title, type (unit/topic/subtopic), parent_id, explanation, sort_order
- `subtopic_contents` — id, node_id, explanation
- `subtopic_questions` — id (serial), node_id, mark_type ("2"/"5"), question, answer
- `events` — id, user_id, university_id, year, branch, exam, config_id, topic_id, subtopic_id, timestamp

### API Endpoints

- `POST /api/auth/login` — Login with college ID + password, returns user with role
- `POST /api/auth/reset-password` — Reset password with collegeId, currentPassword, newPassword
- `GET /api/configs?universityId=X&status=live` — Get configs (universityId optional, defaults to live for non-admins, admins see all statuses)
- `POST /api/configs` — Create new config (admin)
- `POST /api/configs/:id/upload` — Save syllabus/paper file URLs to config
- `POST /api/configs/:id/generate` — Trigger AI content generation (async, returns 202)
- `GET /api/configs/:id/generation-status` — Poll generation progress
- `POST /api/configs/:id/publish` — Publish draft config to live
- `GET /api/nodes?configId=X` — Get syllabus tree nodes for config (includes explanation, sortOrder)
- `GET /api/subtopics/:id` — Get subtopic content with questions array
- `POST /api/events` — Track subtopic consumed event
- `GET /api/admin/stats` — Get per-subtopic event counts
- `POST /api/storage/uploads/request-url` — Get presigned upload URL for file
- `GET /api/storage/public-objects/*` — Serve public assets
- `GET /api/storage/objects/*` — Serve uploaded objects

### AI Content Generation

Claude AI (Anthropic via Replit AI Integrations proxy) generates structured roadmap content:
1. Admin uploads syllabus PDF + optional exam papers
2. Claude parses syllabus → structured JSON (units > topics > subtopics)
3. Claude generates per-subtopic: explanation + 2×2-mark + 2×5-mark Q&A
4. Rate-limited to respect 5 req/min limit (13s between requests)
5. In-memory progress tracking per configId (status: idle/parsing/generating/complete/error)
6. Files stored in Replit Object Storage (GCS bucket)

Key files:
- `artifacts/api-server/src/lib/claude.ts` — Anthropic client wrapper with rate limiting
- `artifacts/api-server/src/lib/pdfExtractor.ts` — PDF text extraction via pdfjs-dist
- `artifacts/api-server/src/lib/generator.ts` — Generation orchestrator
- `artifacts/api-server/src/routes/generation.ts` — Generation API endpoints
- `artifacts/api-server/src/lib/objectStorage.ts` — Object storage service
- `artifacts/api-server/src/routes/storage.ts` — Storage upload/serve endpoints

### Static Universities

JNTU Hyderabad, JNTU Kakinada, Osmania University, Anna University, VTU Belgaum

### Seed Data

Run `pnpm --filter @workspace/scripts run seed` to populate sample data.
Default password for all seed users: "1234567890"
Users: STU001 (student), STU002 (student), STU003 (student), ADMIN (admin)

### Auth Storage

localStorage key: "gpmax_user" stores LoginResponse {id, universityId, branch, year, role}

### Server-side Auth

Admin endpoints protected by `requireAdmin` middleware (artifacts/api-server/src/middleware/adminAuth.ts). Reads `x-user-id` header, verifies user exists and has admin role. The custom-fetch client auto-injects `x-user-id` from localStorage `gpmax_user` on every request.

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references.

- **Always typecheck from the root** — run `pnpm run typecheck`
- **`emitDeclarationOnly`** — only emit `.d.ts` files during typecheck
- **Project references** — package A depends on B → A's `tsconfig.json` lists B in references

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Packages

### `artifacts/api-server` (`@workspace/api-server`)

Express 5 API server with routes for auth, configs, nodes, subtopics, events, and admin stats.

### `artifacts/exam-roadmap` (`@workspace/exam-roadmap`)

React + Vite frontend with wouter routing, Tailwind CSS, Framer Motion animations. GP-Max branding with Zap icon.

### `lib/db` (`@workspace/db`)

Drizzle ORM schema + DB connection for users, configs, nodes, subtopic_contents, subtopic_questions, events tables.

### `lib/api-spec` (`@workspace/api-spec`)

OpenAPI 3.1 spec + Orval codegen config. Run codegen: `pnpm --filter @workspace/api-spec run codegen`

### `lib/api-zod` (`@workspace/api-zod`)

Generated Zod schemas from OpenAPI spec.

### `lib/api-client-react` (`@workspace/api-client-react`)

Generated React Query hooks from OpenAPI spec.

### `scripts` (`@workspace/scripts`)

Utility scripts including database seeder.
