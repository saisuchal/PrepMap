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

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   ├── api-server/         # Express API server
│   └── exam-roadmap/       # Exam Roadmap Platform (React + Vite)
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

## Application: AuraPrep (Exam Roadmap Platform)

An exam-oriented roadmap platform where students navigate a hierarchical syllabus and view subtopics with explanations and 2-mark/5-mark Q&A. Event tracking records when a student consumes a subtopic.

### Features

- **Login**: College ID + hardcoded password ("1234567890"), user stored in localStorage
- **Config Selection**: University > Year > Branch > Exam type selection
- **Roadmap Tree**: Expandable tree: Units > Topics > Subtopics
- **Subtopic Page**: Explanation + 2-mark Q&A + 5-mark Q&A with toggle-to-reveal answers
- **Event Tracking**: IntersectionObserver-based scroll tracking (2s dwell) fires SUBTOPIC_CONSUMED event
- **Admin Page**: Lists subtopics with per-subtopic event counts

### Database Schema (Drizzle ORM)

- `users` — id (college_id), university_id, branch, year
- `configs` — id, university_id, year, branch, subject, exam, is_active
- `nodes` — id, config_id, title, type (unit/topic/subtopic), parent_id
- `subtopic_contents` — id, node_id, explanation, two_mark_question/answer, five_mark_question/answer
- `events` — id, user_id, university_id, year, branch, exam, config_id, topic_id, subtopic_id, timestamp

### API Endpoints

- `POST /api/auth/login` — Login with college ID + password
- `GET /api/configs?universityId=X` — Get active configs for university
- `GET /api/nodes?configId=X` — Get syllabus tree nodes for config
- `GET /api/subtopics/:id` — Get subtopic content by node ID
- `POST /api/events` — Track subtopic consumed event
- `GET /api/admin/stats` — Get per-subtopic event counts

### Static Universities

JNTU Hyderabad, JNTU Kakinada, Osmania University, Anna University, VTU Belgaum

### Seed Data

Run `pnpm --filter @workspace/scripts run seed` to populate sample data (users, configs, nodes with DS and OS content, subtopic Q&A).

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

React + Vite frontend with wouter routing, Tailwind CSS, Framer Motion animations.

### `lib/db` (`@workspace/db`)

Drizzle ORM schema + DB connection for users, configs, nodes, subtopic_contents, events tables.

### `lib/api-spec` (`@workspace/api-spec`)

OpenAPI 3.1 spec + Orval codegen config. Run codegen: `pnpm --filter @workspace/api-spec run codegen`

### `lib/api-zod` (`@workspace/api-zod`)

Generated Zod schemas from OpenAPI spec.

### `lib/api-client-react` (`@workspace/api-client-react`)

Generated React Query hooks from OpenAPI spec.

### `scripts` (`@workspace/scripts`)

Utility scripts including database seeder.
