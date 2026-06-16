# CLAUDE.md — Connection Made Simple

> **Scope:** the real **Connection Made Simple** app — TS/Express backend (`src/`) + `public/index.html` SPA. The offline demo and its full UI conventions live in `../youth app demo/CLAUDE.md`; this SPA is kept aligned to that demo. Project map: `../CLAUDE.md`.

Guidance for Claude Code when working in this package.

## What this is

**Connection Made Simple** (`connection-made-simple`) — a youth ministry platform for YS Brisbane. Phone-first SPA backed by a TypeScript/Express API. Students are *connected* to leaders; "connection" is the core relationship entity. Backend-agnostic architecture identical in structure to the Youth Camp Platform.

- **GitHub:** `987tom1/connection-made-simple`
- **Deployed:** https://connection-made-simple.vercel.app
- **Supabase:** Sydney region (`ap-southeast-2`) — `PERSISTENCE=supabase` + `DATABASE_URL` env var

## Commands

```bash
npm install
npm run dev          # backend + frontend on http://localhost:4300 (tsx watch)
npm run start        # same, no watch
npm run typecheck    # tsc --noEmit (strict)
npm run test         # vitest (71 tests)
```

Default port: **4300**. Set `PORT=xxxx` to override.

## Architecture

```
api (Express) → controllers → services → repositories (interfaces) → core
```

- **`src/core/`** — pure types, entities, enums, Zod schemas, errors. No imports from other layers.
- **`src/repositories/`** — interfaces (DB-swap surface) + in-memory implementations + JSON file persistence + `supabase/` layer.
- **`src/services/`** — all business logic + RBAC. Depend on repo *interfaces* only.
- **`src/api/`** — thin controllers → declarative route table (`http/router.ts`) → Express adapter.
- **`src/container.ts`** — composition root. The ONLY file that names concrete repositories.
- **`src/app.ts`** — `createAppInstance()` factory: builds container, seeds data if `PERSISTENCE=memory`, builds routes.
- **`api/index.ts`** — Vercel serverless entry point; calls `createAppInstance()` and delegates to Express.

## Persistence modes

| `PERSISTENCE` | Backend |
|---|---|
| `memory` (default) | In-memory; seed data runs on startup |
| `json` | In-memory + JSON files in `DATA_DIR` |
| `supabase` | Supabase (Sydney); requires `DATABASE_URL` |

Seed data only runs when `PERSISTENCE=memory`. Production uses `PERSISTENCE=supabase`.

## Key API routes

| Resource | Routes |
|---|---|
| Auth | `POST /auth/login`, `GET /auth/me`, `POST /auth/logout` |
| Students | `GET/POST /students`, `GET /students/search`, `GET/PATCH/DELETE /students/:id` |
| Leaders | `GET/POST /leaders`, `GET/PATCH/DELETE /leaders/:id` |
| Connections | `GET/POST /connections`, `GET /connections/export`, `GET /connections/student/:id`, `GET /connections/leader/:id`, `DELETE /connections/:studentId/:leaderId`, `GET /connections/allocations/export`, `POST /connections/allocations/import` (admin-only allocation CSV round-trip) |
| Overview | `GET /overview` |
| At-risk | `GET /at-risk`, `POST /at-risk/recompute` |
| Trends | `GET /trends` |
| Lifegroup stats | `GET /lifegroups/stats` (per-lifegroup/grade/quad/overall, current + previous term + weekly series) |
| Import | `POST /import/csv`, `GET /import/history` |
| Settings | `GET/PATCH /settings` |
| Admin | `POST /admin/reset` (clears students+leaders+connections+all data), `POST /admin/clear-service-group` (clears service/lifegroup data, **keeps** students+connections+leaders, resets student aggregates), `POST /admin/save-defaults`, `GET /admin/audit` |
| Accounts | `GET/POST /accounts/users`, `PATCH /accounts/users/:id`, etc. |

## Role hierarchy

| Role | Scope | Key capabilities |
|------|-------|-----------------|
| `grade` | Own grade + **own gender** | List own grade/gender students; manage leaders for their cohort; connect same-gender students from any grade. Each grade has separate female/male logins (e.g. `grade9f` / `grade9m`). |
| `quad` | Own quad (e.g. Girls Yr 7–9) | Full connection management **within their gender + bracket**: add leaders, connect/disconnect, edit/remove. Sees only same-gender leaders/students. |
| `director` | Ministry-wide | All of above + import CSV data |
| `admin` | All + back office | Everything + settings, accounts, year-rollover |

There is always exactly one `admin` account. It cannot be deleted.

**Scoping reality:**
- `Actor.gender` is **derived at sign-in** (`auth.service.deriveActorGender`): quad logins
  from their quad; grade logins from the **email convention** (`grade7g`→female, `grade7b`→male,
  or a "girls"/"boys" word). An ungendered grade account (`grade7@`) → `gender: null` → sees
  **both** genders (back-compat). `access-control` exposes `genderScopeOf` + `canAccessStudent`
  (`canAccessGrade && canAccessGender`); every read path (students, at-risk, trends,
  lifegroup-stats, overview, connections, leaders) scopes grade+quad via `canAccessStudent`.
- So a gendered grade login sees **only its grade + gender** across home, leaders/connect,
  my-students, trends, at-risk and search. `director`/`admin` = all. UI leader filters:
  `grade` → none, `quad` → grade-only (own bracket), `director`/`admin` → grade + gender.
- Connect exception: a `grade`/`quad` login may connect/search a student of **another grade**
  but only of **their own gender** (`student.get`/`search` are gender-only; `connection.assign`
  enforces the leader-gender match; the picker keeps searches within the leader's gender).

**Status model:** `atRiskStatus` (`computeStatus`) is kept ONLY for the My Students threshold
highlight; "stopped" now means attended **neither** service nor lifegroup this term. Student
search + the At-Risk screen use **dynamic per-stream qualifiers** computed client-side
(`attendQual`/`qualChips` in the SPA): rising/declining (±5pts vs last term), stopped (0 this
term), combined into rising / mixed / declining / stopped.

**Connection counts:** only students who **attended** a service or lifegroup in the current
OR previous term are "connectable" (`_hasAttended` in the SPA; `attended` in `overview.service`).
Never-attended students are excluded from connected / unconnected / total counts (so they're
never "unconnected") and hidden from the quick-add picker's default view — but stay **searchable**
to add, and still appear if already assigned.

## Quads

Four quads group students by age bracket + gender:
- `g79` — Girls Year 7–9
- `b79` — Boys Year 7–9
- `g1012` — Girls Year 10–12
- `b1012` — Boys Year 10–12

Quad is computed automatically from `grade + gender` via `computeQuad()` in enums.

## Term model (this-term vs previous-term)

Attendance is split into the **current** and **previous** term everywhere; "this term"
is the default, previous is shown as a comparison.

- **Boundaries** come from gaps between consecutive **service dates** > `termGapDays`
  (default 14), Monday-bucketed so service Fridays and lifegroup Mondays land in the
  same term. Only the last two terms are kept; resilient across the calendar-year
  boundary (last year's T4 as previous + this year's T1 as current). Pure helpers:
  `src/services/terms.ts` (`computeTerms`, `classifyDate`, `mondayOf`).
- **Per-student aggregates** (`svc*`, `grp*`, `prev*` on `Student`) are computed **at
  import time** by `src/services/aggregates.ts` (`computeStudentAggregates`). BOTH
  imports (service and lifegroup) recompute BOTH streams from the authoritative
  service boundaries (lifegroup falls back to its own week-gaps when no service data),
  so the split is import-order-independent. Holiday-gap weeks classify to neither term
  and are excluded. **Re-import is required** for these fields to reflect new logic —
  trends/lifegroup-stats compute live and update immediately.
- `import` is the **sole writer** of `prev*` (new-year rollover only wipes data).
- `GET /trends` ministry block is **whole-ministry for every login** (a grade/quad
  login still sees ministry-wide unique + average there); `byQuad`/`byGrade` stay
  scoped. The "Improving/Declining" badge is the trend WITHIN the current term.
- `GET /lifegroups/stats` (`lifegroup-stats.service.ts`) is the per-lifegroup /
  grade / quad / overall source — current + previous term, role-scoped. Each
  `TermAgg` has `uniqueAttenders`, `avgPerWeek`, `weeksRan`, `members` (enrolled =
  distinct students the scope ran for), `totalVisits` (Σ weekly attenders). Notes:
  - **Average denominator = VALID SERVICES in the term** (not weeks lifegroups ran):
    `avgPerWeek = totalVisits / (valid Fridays meeting the floor that term)`, falling
    back to `weeksRan` when there's no service data. Normalises group avg/wk to the
    service calendar.
  - Each `QuadLifegroupStat` carries a **gendered** per-grade breakdown (`q.grades`);
    the SPA uses that for the director drilldowns (not the combined top-level `byGrade`).
  - **Deliberate attribution:** per-LIFEGROUP counts ALL its attenders; per-grade /
    quad / overall count only attenders whose OWN `grade`/`quad` matches. So a single
    lifegroup can show more unique attenders than its grade total when it draws in
    other-grade / no-grade students — kept on purpose as a "reaching beyond its year"
    signal. Don't "fix" it to roll up by the group's grade.

## Key design rules

- **RBAC in one file**: `src/services/access-control.ts`. Never scatter role checks.
- **Validation inside services**: all external input parsed with Zod inside the service.
- **Repos return deep clones**: base repository clones on every read/write.
- **Extensionless imports**: ESM, `moduleResolution: "Bundler"`, no `.js` extensions.
- **Strict TypeScript**: `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride`.
- **Connection lock**: `AppSettings.connectionLockDate` — if set and today >= lockDate, non-admin writes are blocked.

## Key service + repository names

- `ConnectionService` / `makeConnectionService` — connects students to leaders
- `IConnectionRepository` / `InMemoryConnectionRepository` / `SupabaseConnectionRepository`
- Supabase repositories live in `src/repositories/supabase/`

## Seed demo accounts (password: `demo1234`)

| Email | Role | Scope |
|-------|------|-------|
| `admin@youth.ministry` | admin | All |
| `director@youth.ministry` | director | All |
| `g79@youth.ministry` | quad | Girls Yr 7–9 |
| `b79@youth.ministry` | quad | Boys Yr 7–9 |
| `g1012@youth.ministry` | quad | Girls Yr 10–12 |
| `b1012@youth.ministry` | quad | Boys Yr 10–12 |
| `grade7@youth.ministry` … `grade12@youth.ministry` | grade | one per grade (the in-code seed has one account per grade) |

**Email convention:** grade logins use **`g` (girls) / `b` (boys)** suffixes —
e.g. `grade7g@youth.ministry`, `grade7b@youth.ministry` (NOT `…f` / `…m`). Account
emails are **editable** in admin → Accounts → Edit (`account.service.update` accepts
`email` with a uniqueness check), so the actual logins can be renamed to this scheme.

## Environment variables

```
PORT=4300
NODE_ENV=production
PERSISTENCE=supabase     # production; use "memory" for local dev with seed data
DATABASE_URL=<supabase-connection-string>
DATA_DIR=./data          # only used for PERSISTENCE=json
CORS_ORIGINS=*
```

## Frontend

`public/index.html` — phone-first SPA that calls the Express backend via relative API paths. Kept aligned to `../youth app demo/allocation-platform.html` (the canonical offline demo, deployed at https://yc-camp-demo.vercel.app). See `../youth app demo/CLAUDE.md` for demo UI conventions.

**Connection Audit module** is ported into the SPA as a delimited block (`/* ── CA MODULE … ── */`); remove = delete blocks + grep-delete `/*CA-HOOK*/` lines. Data via `CA.load()` → `/students` + `/trends` + `/settings` + `/lifegroups/stats`. Lifegroup Health is a **per-lifegroup** table (quad filter buttons; columns enrolled/unique/visits-per-unique/run/avg-this/avg-last) built from `/lifegroups/stats`; the per-quad funnel is the integration ladder; audit uploads start EMPTY (no demo seed) and are cleared by Full Reset AND Clear Service/Group Data via `/*CA-HOOK*/`.

- **Connection allocations** (admin only): Admin → Data tab exports/imports a student↔leader
  allocation CSV (`First Name,Last Name,Grade,Gender,Leader`, one pair per row, grouped by
  student). Import is name-matched and column-agnostic to grade/gender, syncs per student
  (students absent from the file are untouched), skips a student's removals if any of their
  leader names is unmatched, and returns a report of unmatched/ambiguous names. Logic lives in
  the pure `src/services/connection-allocations.ts`; `parseAllocationCSV` in the SPA preserves
  all columns (unlike attendance `parseCSV`).

### SPA architecture

**Persistent shell** — header + nav are built once on login via `_initShell()` and never rebuilt. All page navigations update only `<main id="page-main">` via `setApp(h)`. The `_shellReady` flag gates this; set to `false` on logout.

**Client-side cache** — `Cache` object (30-second TTL) wraps all `API.get()` calls. Cache is invalidated on every write (connections, leaders, settings, import, admin, users). After login `_prefetch()` fires background fetches for all 7 common endpoints so navigations after the first are instant.

**Cache-skip spinner** — render functions check `_allCached(...paths)` before showing the loading spinner; cached navigations render immediately.

**Scroll handling** — the **window** is the scroller (`.pg` is not). `setApp()` resets
to top only when navigating to a DIFFERENT page (`S.page !== _lastRenderedPage`) and
**preserves** `window.scrollY` on same-page re-renders, so opening a dropdown doesn't
jump to the top. Don't re-add per-page `.pg.scrollTop` save/restore — it's a no-op.

**Collapsible dropdowns** — Home/Trends quad→grade→lifegroup dropdowns are **pre-rendered
hidden and toggled in-DOM** (no re-render), like the At-Risk sections. Pattern: a `.drop`
card with a `.drop-head` (`onclick="_drop('uniqueId')"`, chevron `.drop-chev`) and a
`.drop-body` (hidden until the card gets `.open`); direct-child CSS selectors so nesting
works. This avoids the loading-spinner flash when the 30s cache has expired. `_hAttTile`
(opts.dropId) and `_lgGradeBlock(g, showPrev, gsfx, id)` emit this structure. Don't bring
back expand-state vars / `renderHome()`/`renderTrends()` toggles.

**Stale-render guard** — `renderHome`/`renderTrends` capture `S.page` before their
`await Promise.all(...)` and bail before the final `setApp` if `S.page` changed, so a slow
`/lifegroups/stats` on a page you've left can't overwrite the new page (the stuck-spinner /
wrong-page bug when switching menus fast).

**Gendered tile labels** — `_loginGender(u)` (quad→quad gender; grade→email `…g`/`…b`) +
`_gsfx(gender)` (" Girls"/" Boys") append the gender to grade/quad tiles whose numbers are
gender-specific (e.g. "Grade 11 Boys").

**Shared display helpers** (defined near `quadChip`): `termRow(...)` renders "This term … ·
Last term …" (student search, My Students, at-risk); `isRising(s)` / `_hasAttended(s)` /
`attendQual(s)` classify students; `fmtPhone`/`callPhone`/`phoneLink` format numbers (space
after the 4th & 7th digit) and tap-to-call (confirm → `tel:`).

### Icon system

All icons are inline SVG via the `IC` path registry. Helper functions:

| Function | Size | Use |
|---|---|---|
| `icN(k)` | 22 px | Nav, buttons, titles |
| `icS(k)` | 16 px | Inline, chips, small buttons |
| `icLg(k)` | 32 px | Large feature icons |
| `icEmpty(k)` | 48 px | Empty-state backgrounds |

Current IC keys: `home, users, chart, alert, id, upload, settings, link, edit, trash, lock, unlock, logout, target, check, key, info, clipboard, pie, group, deck, chevr, chevd, arru, arrd, arrr, xmark`

No emoji or Unicode symbol characters anywhere in the SPA — everything is SVG.

### Service worker (`public/sw.js`)

- Cache name: `cms-v3` (bump on breaking changes to force eviction)
- HTML shell (`/`): **network-first** — always fetches fresh HTML when online, falls back to cache offline
- API routes: **network-only** (never cached), matched by `API_RE`
- Other assets: **cache-first**
- SW registration in the HTML listens for `controllerchange` and reloads the page automatically when a new SW activates after a deploy — no manual cache clearing needed.
- **GOTCHA:** every API resource MUST be listed in `API_RE`. A missing one (this bit
  us with `lifegroups`) falls through to the cache-first asset path and can get the
  SPA HTML cached under its URL, breaking JSON parsing (symptom: "… unavailable").
  When adding a new top-level API route, add it to `API_RE` and bump the cache name.
