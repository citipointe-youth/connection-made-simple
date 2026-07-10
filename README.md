# YS Connection

A phone-first youth ministry platform: track service and lifegroup attendance,
connect students to leaders, spot who's drifting away, and run the whole thing
from a phone. TypeScript/Express backend + a single-file SPA, deployable to
your own Supabase + Vercel accounts.

Originally built for Youth Society Brisbane as "Connection Made Simple" (later
briefly "Youth Connection") — the app is now configurable per deployment
(branding, terminology, cohort structure, roles, modules, import dialect) via
the in-app **Youth Ministry Setup** wizard (Admin → Settings), so any youth
ministry can run its own copy with its own look, language, and structure. The
Youth Society Brisbane deployment itself needs zero configuration — every
setting defaults to its current behaviour, under the name "YS Connection".

## Quick start (local development)

```bash
npm install
npm run dev          # backend + frontend on http://localhost:4300 (tsx watch)
npm run typecheck    # tsc --noEmit (strict)
npm run test         # vitest
```

Default persistence is in-memory with seed data (`PERSISTENCE=memory`) — no
database needed for local development. Seed accounts (password `demo1234`):

| Email | Role |
|-------|------|
| `admin@youth.ministry` | admin |
| `director@youth.ministry` | director |
| `g79@youth.ministry` / `b79@youth.ministry` / `g1012@youth.ministry` / `b1012@youth.ministry` | quad |
| `grade7@youth.ministry` … `grade12@youth.ministry` | grade |

## Deploying your own copy

See **[docs/DEPLOYING.md](docs/DEPLOYING.md)** for the full path: Supabase
project → migrations → Vercel project + env vars → first login → Youth
Ministry Setup.

## Architecture

```
api (Express) → controllers → services → repositories (interfaces) → core
```

- `src/core/` — pure types, entities, enums, Zod schemas, errors.
- `src/repositories/` — interfaces + in-memory / JSON-file / Supabase implementations.
- `src/services/` — business logic + RBAC (`access-control.ts`).
- `src/api/` — controllers → declarative route table → Express adapter.
- `src/container.ts` — composition root (the only file naming concrete repositories).
- `public/index.html` — the phone-first SPA (single file, vanilla JS).

See `CLAUDE.md` for the full architecture reference, gotchas, and history —
it's written for an AI coding assistant but is equally useful as an engineer's
onboarding doc.

## Configuring a deployment

Admin → Settings → **Youth Ministry Setup** walks through:

1. **Preset** — Large graded ministry (AU, the default) / Two-bracket / Small
   flat / Micro. Picking a preset sets every group below at once.
2. **Branding** — ministry name, app name, colours, logo.
3. **Terminology** — what to call a small group, the main service, etc.
4. **Structure** — grade range, cohort model, gender policy.
5. **Roles** — role labels (e.g. "Youth Pastor" instead of "Admin").
6. **Modules** — Connection Audit, lifegroups, push notifications, export guides.

Nothing here deletes data and it's revisitable at any time.
