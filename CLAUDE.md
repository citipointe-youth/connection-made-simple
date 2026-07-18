# CLAUDE.md — YS Connection

> **Scope:** the real **YS Connection** app (formerly "Connection Made Simple") — TS/Express backend (`src/`) + `public/index.html` SPA. The offline demo and its full UI conventions live in `../youth app demo/CLAUDE.md`; this SPA is kept aligned to that demo. Project map: `../CLAUDE.md`.

Guidance for Claude Code when working in this package.

## What this is

**YS Connection** (`ys-connection`, formerly `connection-made-simple`) — a youth ministry platform for YS Brisbane. Phone-first SPA backed by a TypeScript/Express API. Students are *connected* to leaders; "connection" is the core relationship entity. Backend-agnostic architecture identical in structure to the Youth Camp Platform.

- **GitHub:** `citipointe-youth/ys-connection` (migrated from `987tom1` 2026-06-22; renamed from `connection-made-simple` → `youth-connection` → `ys-connection` 2026-07-11; org owns the GitHub repo, Supabase org, and Vercel team)
- **Deployed:** https://ys-connection.vercel.app (Vercel team `citipointe-youth`; auto-deploys from `master`)
- **Supabase:** Sydney region (`ap-southeast-2`), project ref `ltcblcudlzlzfcyzlhpc` — `PERSISTENCE=supabase` + `DATABASE_URL` env var

## Commands

```bash
npm install
npm run dev          # backend + frontend on http://localhost:4300 (tsx watch)
npm run start        # same, no watch
npm run typecheck    # tsc --noEmit (strict)
npm run test         # vitest (186 tests)
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
| Students | `GET/POST /students`, `GET /students/search`, `GET/PATCH/DELETE /students/:id`. `GET /students` takes `?crossGrade=1` — widens a grade/quad login's scoping from "own grade/bracket + own gender" to "own gender only" (Connect Setup's Add Students picker; see "Add Students picker now actually offers a broadened leader's other grade(s)" below) |
| Leaders | `GET/POST /leaders`, `GET/PATCH/DELETE /leaders/:id`, `PATCH /leaders/:id/sms-template` (self-service, no ownership check — see the SMS templates note below), `PATCH /leaders/:id/grades` (self-service grade broadening, same no-ownership-check pattern — see "Leader self-service grade broadening" below) |
| Connections | `GET/POST /connections` (also takes `?crossGrade=1`, same widening as `/students` above), `GET /connections/export` (own-gender-only for grade/quad, unconditionally), `GET /connections/student/:id`, `GET /connections/leader/:id`, `DELETE /connections/:studentId/:leaderId`, `GET /connections/allocations/export`, `POST /connections/allocations/import` (admin-only allocation CSV round-trip; body optionally takes `autoCreateLeaders: true` — see "Admin bug/improvement batch" below) |
| Overview | `GET /overview` |
| At-risk | `GET /at-risk`, `POST /at-risk/recompute` |
| Trends | `GET /trends` |
| Lifegroup stats | `GET /lifegroups/stats` (per-lifegroup/grade/quad/overall, current + previous term + weekly series) |
| Import | `POST /import/csv`, `GET /import/history`, `DELETE /import/history` (clear log), `DELETE /import/history/:id` (remove one) |
| Settings | `GET/PATCH /settings` |
| Admin | `POST /admin/reset` (clears students+leaders+connections+attendance **and connection_audits** — see below), `POST /admin/clear-service-group` (clears service/lifegroup data, **keeps** students+connections+leaders, resets student aggregates), `GET /admin/audit` (log kept; unreachable from the SPA since the Audit tab was removed) |
| Connection audits | `POST/GET /audits`, `GET/DELETE /audits/:year`, `POST /audits/finalize-live` (builds this year's snapshot from live tables, no CSV upload — used by the New Year Refresh wizard), `GET /audits/export-all` / `POST /audits/import-all` (admin-only full-table backup/restore — see "New Year Refresh wizard" below; registered before `/audits/:year` since Express matches route registration order) |
| Accounts | `GET/POST /accounts/users`, `PATCH /accounts/users/:id`, `POST /accounts/users/password` (admin resets another account), `POST /accounts/me/password` (self-service, requires current password — distinct endpoint, no admin:manage needed; returns `{ ok, token }` — a freshly-issued session token, since `mustChangePassword` is baked into the token at login and this is the one write that needs the caller's own token refreshed — see "Forced password change" gotcha below), `POST /accounts/cohort-layout/preview` / `POST /accounts/cohort-layout/apply` (admin-only "Apply account layout" dry-run/apply pair — see "Admin bug/improvement batch" below) |

**Clearing import history ≠ deleting data.** The Import screen's "Clear All" and per-row
trash only remove `import_records` log rows. `service_sessions.import_id` /
`lifegroup_weeks.import_id` are **`ON DELETE SET NULL`** (migration `013`; they were
`CASCADE` before, which silently wiped attendance in production while the in-memory dev path
didn't — a nasty divergence). Deleting the actual attendance is the job of admin → **Clear
Service/Group data** (`clearServiceGroupData`), which deletes sessions/weeks/attendance
directly and resets student aggregates. `import_id` is provenance only (imports are
full-replace; `deleteByImport` is unused), so nulling it is safe.

The Import screen's **new-vs-known preview** (`previewServiceImport`) counts against a fresh
`/students` fetch, NOT the 30s `Cache.get` — that cache expires and is wiped by `Cache.clear()`
after every import, which made a re-upload preview show everyone as "new" with 0 updates even
though the server correctly matched them by name.

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
  from their quad; grade logins from the **username convention** (`grade7g`→female, `grade7b`→male,
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

**Status model:** there are **no manual at-risk thresholds**. `atRiskStatus` (`computeStatus`
in `atrisk.service.ts`) is **threshold-free** and mirrors the SPA's `attendQual`: never-engaged
(no attendance this OR previous term) → `regular`; attended before but **neither** service nor
lifegroup this term → `stopped`; a stream's rate dropped **≥20pts** vs last term (or a stream
stopped) → `declining`; otherwise `regular`. It feeds the My Students chips, the leader-card
"at risk" counts, and the home At-Risk highlight. Student search + the At-Risk screen compute
the same model client-side (`attendQual`/`qualChips`, ±20pts), and the At-Risk page additionally
filters out never-engaged youth (`_hasAttended`). Keep `computeStatus` and `attendQual` in sync.

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
  (default 14), Saturday-bucketed so service Fridays and lifegroup Mondays land in the
  same Sat–Fri week. Only the last two terms are kept; resilient across the calendar-year
  boundary (last year's T4 as previous + this year's T1 as current). Pure helpers:
  `src/services/terms.ts` (`computeTerms`, `classifyDate`, `saturdayOf`).
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
  - **Average denominator depends on scope:** grade / quad / overall use **VALID
    SERVICES in the term** — `avgPerWeek = totalVisits / (valid Fridays meeting the
    floor that term)`, falling back to `weeksRan` when there's no service data —
    which normalises those averages to the service calendar. An **individual
    lifegroup** instead divides by the **weeks THAT group met** (`weeksRan`), so its
    average reflects its own cadence. (`termAgg`'s `divideByWeeksRan` flag, set by
    `statForGroup`.)
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

## Key service + repository names

- `ConnectionService` / `makeConnectionService` — connects students to leaders
- `IConnectionRepository` / `InMemoryConnectionRepository` / `SupabaseConnectionRepository`
- Supabase repositories live in `src/repositories/supabase/`

## Seed demo accounts

| Username | Role | Scope |
|-------|------|-------|
| `admin` | admin | All |
| `director` | director | All |
| `g79` | quad | Girls Yr 7–9 |
| `b79` | quad | Boys Yr 7–9 |
| `g1012` | quad | Girls Yr 10–12 |
| `b1012` | quad | Boys Yr 10–12 |
| `grade7` … `grade12` | grade | one per grade (the in-code seed has one account per grade) |

Local `PERSISTENCE=memory` dev/demo mode: password `demo1234` for all of the above,
same as before. **Supabase/production accounts are different:** every account
inserted by `0003_seed_accounts.sql` (`supabase/migrations/` — the pre-2026-07
history of this seed data, back when it used fake `@youth.ministry` emails, lives
archived in `supabase/migrations_archive/002_seed_admin.sql` /
`005_seed_users.sql` / `017_must_change_password.sql`) is flagged
`must_change_password = true` inline at insert — the account holder must set their
own password via `POST /accounts/me/password` (or the forced first-login screen)
before anything else is reachable. See "Forced password change" under Security
notes.

**Username convention:** grade logins use **`g` (girls) / `b` (boys)** suffixes —
e.g. `grade7g`, `grade7b` (NOT `…f` / `…m`, an earlier naming scheme). Usernames are
**editable** in admin → Accounts → Edit (`account.service.update` accepts `email`
with a uniqueness check — the field is internally still named `email`, it's just
not treated as one anywhere in the app), so the actual logins can be renamed to
this scheme.

**`gender` is now set explicitly on every seeded grade account** (migration `0003`
inserts it; migration `0004` backfills it for a database `0003` already ran
against) rather than being inferred from the `g`/`b` suffix at sign-in time —
see "Admin bug/improvement batch" below for why (the grade-change auto-rename
needs it to tell a still-default account name from a customised one).

## Environment variables

```
PORT=4300
NODE_ENV=production
PERSISTENCE=supabase     # production; use "memory" for local dev with seed data
DATABASE_URL=<supabase-connection-string>
DATA_DIR=./data          # only used for PERSISTENCE=json
CORS_ORIGINS=*
```

**GOTCHA — production `DATABASE_URL` must use the connection POOLER, not the direct
connection.** On Vercel serverless, the direct connection (`db.<ref>.supabase.co:5432`)
fails because Supabase now serves it over IPv6 only and Vercel functions are IPv4. Use the
Supavisor pooler with the `postgres.<ref>` username:
`postgresql://postgres.<ref>:<password>@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres`.

**Use SESSION mode (port `5432`), NOT transaction mode (`6543`).** The transaction-mode
pooler intermittently handed back dead connections (queries dispatched, no response, 20 s
timeout → 503) under this app's serverless + burst pattern — the root cause of the 2026-07
outage. Session mode fixed it; see the "✅ RESOLVED" note in the incident history below for
the full evidence and the connection-ceiling mitigation levers.

## Frontend

`public/index.html` — phone-first SPA that calls the Express backend via relative API paths. Kept aligned to `../youth app demo/allocation-platform.html` (the canonical offline demo, deployed at https://yc-camp-demo.vercel.app). See `../youth app demo/CLAUDE.md` for demo UI conventions.

**Connection Audit module** is ported into the SPA as a delimited block (`/* ── CA MODULE … ── */`); remove = delete blocks + grep-delete `/*CA-HOOK*/` lines. The per-quad funnel is the integration ladder built from `D.students` (grade×gender cohorts).

**Audits are server-stored (since 2026-06-21).** The audit is now a **self-contained, year-keyed snapshot** rather than a live read + localStorage overlay:
- Backend: `connection_audits` table (migration `009`, one row per calendar year, `jsonb` snapshot). Routes `POST/GET /audits`, `GET/DELETE /audits/:year` (director/admin via `import:run`). `ConnectionAuditService` runs the *same* term/aggregate engine the importer uses on the uploaded YTD CSVs — it does **not** touch the live tables. Live importer is untouched.
- Pure helpers: `src/services/year-terms.ts` (`computeAllTerms` → N labelled terms `<year>-T<ordinal>`), `year-aggregates.ts` (`computeYearAggregates` → per-term student aggregates), `attendance-build.ts` (name-keyed CSV→model builders, audit-only; importer keeps its own merge path).
- SPA: the Data tab uploads the **full YTD service + group CSVs** plus the 4 CRM overlays (team/connect/decision/flows) as one audit (`CA.saveAudit()` → `POST /audits`); `CA.load()` now derives `D` from the loaded snapshot scoped to the selected term, NOT from live endpoints. A **year picker** + **term/YTD switcher** (`CA.setYear`/`CA.setTerm`) drive the view; the latest term of a mid-term upload is flagged `inProgress`. Re-uploading a year overwrites it (latest-per-year).
- **Lifegroup Health in audit mode:** the per-named-lifegroup Health table is built
  **from the snapshot** — `snapshot.lgStatsByTerm` (`buildLifegroupStats`, server-side) →
  `_auditLgStats(sel, prev)` assembles the `byQuad→grades→lifegroups` shape `lifegroupRows()`
  expects. No live `/lifegroups/stats` call. (This needs `audits` in the SW `API_RE` — see
  the SW gotcha — or a stale snapshot is served and the table reads empty.)
- **Term / YTD date filtering in the SPA (`model()`):** connect/decision rows are filtered by `inPeriod(r.date)` (ISO string comparison). A specific term bounds to that term's `startDate`/`endDate`; **year-to-date (`TERM==='ALL'`) bounds to the UNION of the audit's term dates** (`min startDate … max endDate`) — the CRM exports carry the full submission history, so without this bound prior-year rows (and stray future-dated entries, e.g. a mis-typed "decision date" of 2028) leaked into the YTD funnel. Undated rows are always included. Note this is a safety net: `parseRows` already selects the **"Date Submitted"** column (not DOB / not the free-text "when did you make a decision" field), so the old years visible in the raw CSV aren't normally the date used. Team rows carry no dates — for a specific term, a team member only reaches stage 5 if they also attended that term (`sA>0 || gA>0`); YTD counts the full roster.
- **CRM CSV parsing (`parseRows` / `parseMatrixRows`):** `parseRows` handles lean one-row-per-person exports with a name column and an optional date column; the date column is matched by exact name first ("date", "decision date", "connect date") then by any header containing `\bdate\b` that isn't birth/DOB-related. `parseMatrixRows` handles the service-attendance matrix format (date-format column headers, Y/yes/1/true cells per row per session) — connect takes the earliest Y date, decision takes the latest. `upload()` tries matrix first for connect/decision, falls back to `parseRows`.
- **Known edge case:** the term `endDate` is the Saturday of the last service week. Decisions/connects recorded on the Friday of that same week fall after `endDate` and are excluded from the term (attributed to neither term, but appear in YTD).
- **v1 limitations:** the Friday session sparkline depends on live `/trends` (null in audit
  mode, since `load()` sets `trends:null`) → it renders empty in the audit; the
  funnel/overview/people/Lifegroup-Health work per-term. Term ordinals derive from each
  term's calendar-year start, so a ministry year crossing the Dec/Jan boundary may mislabel.

- **Connection allocations** (admin only): Admin → Data tab exports/imports a student↔leader
  allocation CSV (`First Name,Last Name,Grade,Gender,Leader`, one pair per row, grouped by
  student). Import is name-matched and column-agnostic to grade/gender, syncs per student
  (students absent from the file are untouched), skips a student's removals if any of their
  leader names is unmatched, and returns a report of unmatched/ambiguous names. Logic lives in
  the pure `src/services/connection-allocations.ts`; `parseAllocationCSV` in the SPA preserves
  all columns (unlike attendance `parseCSV`).
- **Connect Setup export** (`exportConnectCSV()`, all roles — own-gender-only for grade/quad):
  `GET /connections/export` now returns structured rows (`ConnectionService.exportCsv` /
  `ExportRow`, not a CSV string); the SPA builds an **.xlsx** workbook client-side via the
  same vendored SheetJS build used to read Excel imports (`_ensureXlsx()`), lazy-loaded on
  click. One row per leader (name/grade/gender only) followed by that leader's connected
  students (their own grade/gender — not the leader's — plus Health/Youth %/Lifegroup %/DOB/
  Mobile/Parent Mobile), grouping relies on the rows already being sorted leader-then-student.
  **Independent of** the admin-only allocations export/import above — separate route, service
  method (`exportCsv` vs `exportAllocations`), and frontend function
  (`exportConnectCSV()` vs `exportAllocationsCSV()`); changing one doesn't affect the other.

### Elvanto export guide (2026-07-03)

Two screenshot walkthroughs teach users how to produce the upload files in Elvanto, shown in a
full-screen step viewer (`#exportGuide` overlay; `.eg-*` CSS; `EXPORT_GUIDES`/`openExportGuide`/
`_egDraw`/`_egGo`/`_egZoom`/`_egTs`/`_egTe` — ported from the Camp Platform's import guide):
- **`openExportGuide('import')`** — button on the main Import screen (`renderImport`). 2 steps:
  Service Individual Attendance (Friday Nights) and Group Individual Attendance. Both steps carry
  an amber **date-range note** (`_EG_DATE_NOTE`): the app reads only the current + previous term,
  "This calendar year" is fine mid-year, but in **Term 1** the user must set a Custom range
  starting from the beginning of last year's Term 4.
- **`openExportGuide('audit')`** — button in the Connection Audit Data tab upload card (`rData`).
  4 steps: Student Team (= Service Individual Attendance with the **Sunday 10:15am** service),
  Decision Form export, New Child/Youth form export (the "New Connect" file), and People Flow
  Steps Detail report (the flows file).
- Steps flick via Back/Next buttons, dot indicators, or touch swipe (≥48px); screenshots
  tap-to-zoom to a 220%-width horizontally-scrollable view (`.eg-imgwrap.zoom`). Images live in
  **`public/img/export-help/*.png`** (same-origin, CSP `img-src 'self'` covers them, cache-first
  in the SW — bump the SW cache if an image is replaced).

### Grade-login UX overhaul (2026-07-03)

A punch list of small UI fixes/renames, mostly targeted at the `grade` login but shared
across roles wherever the same screen/component is used:
- **Nav renames** (all roles, `navItems()`): `At Risk` → `At Risk & Rising`, `Leaders & Connect`
  → `Connect Setup`, `My Students` → `My Connections`. (`At Risk & Rising` was renamed again,
  later the same day, to **`Health`** — see the note below.) Bottom-nav two-line labels (`mbl`) use a
  shared `.ni-lbl` pattern (first line normal, second line smaller/faded) for any label that
  wraps — keep new multi-word nav labels on this pattern rather than plain wrapped text, or the
  bottom nav's row heights look uneven.
- **Nav reorder** — grade-only: bottom-4 is now Home / At Risk & Rising / My Connections /
  Connect Setup (was Home / My Students / Leaders & Connect / At Risk), with Student Search
  dropped from grade's quick actions. Quad/director/admin keep their existing bottom-4 order,
  just relabeled.
- **Connect Setup icon** changed from the people icon (`users`, shared with My Connections) to
  an arrow (`arrr`).
- **Home hero card**: "Groups" → "Lifegroups" (hero card + the `_hAttTile` Attendance-by-Quad/Grade
  tiles); the "Grade X" role badge no longer shows on the hero card itself (still shows in the
  persistent header — that's `roleBadge(u)` at a different call site, untouched); "Quick Actions"
  subtitle removed above the quick-action button grid.
- **Home follow-up section**: heading "This week's follow-up" → "Follow Up"; a `helpTip()`
  explains these are students who attended recently but weren't seen last time; "Not seen at
  Friday"/"Not seen at Lifegroup" reworded to "Not Seen Last Friday (D/M)" / "Not At A Lifegroup
  Last Week (ending D/M)"; `_followupListHtml` rows show name only (grade/gender/birthday
  dropped to keep rows compact).
- **Upcoming Birthdays**: rows drop grade, gender, and the parent phone number — only the
  student's own mobile (if present) plus "turns N" and their leader(s).
- **Connect Setup (`renderConnectView`)**: title and the Add Leader/Export CSV buttons sit on
  one row (`align-items:center`, not `flex-start` against a two-line title+subtitle block); a
  read-only "Students not Connected (N)" `.drop` dropdown sits below the Total/Connected/Pending
  stat row (named "Unallocated students" until 2026-07-03); the grade-only "Tap Add Students…"
  tip alert is gone (redundant with the tooltip). Per leader: grade/gender and the "N students"
  count share one line (`justify-content:space-between`, ellipsis on the grade/gender span so a
  long list still doesn't push the count off); the student preview (`.connect-students`) caps to
  a ~3-row scroll window (`max-height:126px`, was a hard `slice(0,8)` + "+N more/View all" link)
  with a persistent faint scrollbar thumb (`::-webkit-scrollbar-thumb` + `scrollbar-color`) since
  a touch scrollbar only flashes during an active drag and is easy to miss in such a short list.
- **At Risk & Rising tiles** (screen since renamed to `Health` — see below): grade logins don't see the quad chip (constant/uninformative for a
  single-grade login); grade/gender + the qualifier chips moved to their own second line below
  the name (was crowding the name line). Qualifier chips get a dedicated `_arQualChips(s)` (NOT
  the shared `qualChips(s)` used by Search/admin table/student detail, which is untouched):
  rising/declining drop the "Rising"/"Declining" word and show just the coloured arrow icon +
  stream name at a smaller size (`.ic-xs`, 12px vs the normal 16px `icS`), and "Service" → "Youth"
  for that arrow variant specifically (the "Stopped …" wording, which uses the alert icon rather
  than an arrow, is untouched — wasn't in scope).
- **My Students**: the big centered leader-identity card above the list is gone (redundant with
  the "I am…" dropdown right above it); each student row's Yr/gender/birthday moves onto the name
  line in smaller text (was its own `li-sub` line, making rows taller); "Fridays" stream label →
  "Youth".
- **Mobile viewport fixes**: `overscroll-behavior-y:contain` on `html`/`body` stops the native
  rubber-band bounce from dragging the whole page past the sticky header/fixed bottom nav;
  `min-height:100vh;min-height:100dvh` (vh first as a fallback) on `body`/`#app` so the fixed
  bottom nav doesn't visually jump as a mobile browser's URL bar hides/shows mid-scroll — both
  ported from fixes already proven in the camp platform, adapted to this SPA's window-scroll
  architecture (the camp app instead uses a fixed-height `.app` frame with per-screen absolute
  `.screen` containers).

### SPA architecture

**Persistent shell** — header + nav are built once on login via `_initShell()` and never rebuilt. All page navigations update only `<main id="page-main">` via `setApp(h)`. The `_shellReady` flag gates this; set to `false` on logout.

**Client-side cache** — `Cache` object (30-second TTL) wraps all `API.get()` calls. Cache is invalidated on every write (connections, leaders, settings, import, admin, users). After login `_prefetch()` fires background fetches for all 7 common endpoints so navigations after the first are instant.

**Stale-while-revalidate navigation** — every page render function (`renderHome`, `renderTrends`, `renderConnect`, `renderUpcomingBirthdays`, `renderMyStudents`, `renderStudents`, `renderAtRisk`, `renderImport`, `renderAdmin`, plus the CA module's own pages) follows the same `<PAGE>_PATHS` + `allFresh`/`haveStale` pattern: all-fresh renders straight from cache; any-stale paints instantly from `Cache.getStale(...)` and revalidates in the background via a `_revalidate<Page>()` helper that re-renders only if `S.page` hasn't changed; nothing cached at all just shows an empty `<main>` until data arrives (2026-07-03: no more full-page spinner placeholder — see the `#nprog` note below). `renderLeaders`/`renderQuadView`/`renderMyQuad`/`renderNotifications` are dead/unreachable code (not in the `render()` dispatch table) and were deliberately left on the old `_allCached` pattern.

**Global loading bar (`#nprog`)** — a thin accent-coloured bar, reference-counted via `_npStart`/`_npDone` called from the `API` IIFE's `r()`. Since `API.get` only calls `r()` on a cache miss, cached reads never trigger it — only real network requests do. **Position (2026-07-03):** `top` is *not* a fixed `0` — `_positionNprog()` measures `.hdr`'s rendered height and sets it inline so the bar sits at the header's bottom edge (falls back to `0` pre-login, before `.hdr` exists); called after `_initShell()`, after `renderLogin()`, and on `resize`. It used to sit at literal `top:0`, overlapping the notch/status-bar strip and the header's own gradient — functionally firing but effectively invisible. Ported from the camp platform, which anchors the same bar to its header's bottom edge natively (`position:absolute;bottom:-1px` inside the header); CMS's window-scroll architecture needs the bar to also work pre-login (no `.hdr` yet), hence the JS measurement instead of DOM nesting. The full-page loading **spinner** placeholder (`.loading`/`.spin`/`.lt`) that used to fill `<main>` while a screen's data was uncached has been removed — `#nprog` alone is the loading signal now. `.spin` still exists at its original small inline size for three contextual action-feedback spots (Recompute button, Import parsing/reading messages) that show *what* is in progress, not just *that* something is.

**Scroll handling** — the **window** is the scroller (`.pg` is not). `setApp()` resets
to top only when navigating to a DIFFERENT page (`S.page !== _lastRenderedPage`) and
**preserves** `window.scrollY` on same-page re-renders, so opening a dropdown doesn't
jump to the top. Don't re-add per-page `.pg.scrollTop` save/restore — it's a no-op.

**Collapsible dropdowns** — Home/Trends quad→grade→lifegroup dropdowns are **pre-rendered
hidden and toggled in-DOM** (no re-render), like the At-Risk sections. Pattern: a `.drop`
card with a `.drop-head` (`onclick="_drop('uniqueId')"`, chevron `.drop-chev`) and a
`.drop-body` (hidden until the card gets `.open`); direct-child CSS selectors so nesting
works. This avoids a re-render flash when the 30s cache has expired. `_hAttTile`
(opts.dropId) and `_lgGradeBlock(g, showPrev, gsfx, id)` emit this structure. Don't bring
back expand-state vars / `renderHome()`/`renderTrends()` toggles.

**Stale-render guard** — `renderHome`/`renderTrends` capture `S.page` before their
`await Promise.all(...)` and bail before the final `setApp` if `S.page` changed, so a slow
`/lifegroups/stats` on a page you've left can't overwrite the new page (the stuck-spinner /
wrong-page bug when switching menus fast).

**Gendered tile labels** — `_loginGender(u)` (quad→quad gender; grade→username `…g`/`…b`) +
`_gsfx(gender)` (" Girls"/" Boys") append the gender to grade/quad tiles whose numbers are
gender-specific (e.g. "Grade 11 Boys").

**Shared display helpers** (defined near `quadChip`): `termRow(...)` renders "This term … ·
Last term …" (student search, My Students, at-risk); `isRising(s)` / `_hasAttended(s)` /
`attendQual(s)` classify students; `fmtPhone`/`callPhone`/`phoneLink` format numbers (space
after the 4th & 7th digit) and tap-to-call. **`callPhone` (2026-07-03)** shows a Call /
Message / Cancel action sheet via the shared `modal()` — iOS's native `tel:` confirmation
can't be extended with a "Message" option, so this replaced the old bare `confirm('Call
…?')`. Applies everywhere `phoneLink` is used (all roles, every screen with a phone number).

### Icon system

All icons are inline SVG via the `IC` path registry. Helper functions:

| Function | Size | Use |
|---|---|---|
| `icN(k)` | 22 px | Nav, buttons, titles |
| `icS(k)` | 16 px | Inline, chips, small buttons |
| `icLg(k)` | 32 px | Large feature icons |
| `icEmpty(k)` | 48 px | Empty-state backgrounds |

Current IC keys: `home, users, chart, alert, id, upload, settings, link, edit, trash, lock, unlock, logout, target, check, key, info, clipboard, pie, group, deck, chevr, chevd, arru, arrd, arrr, xmark, cake`

No emoji or Unicode symbol characters anywhere in the SPA — everything is SVG.

### Service worker (`public/sw.js`)

- Cache name: `cms-v32` (bump on any SPA/asset change to force eviction — see the dated changelog for the running history)
- **Excel import** (all upload points — main import, allocations, every Connection Audit slot):
  `readXlsx(buf)` now uses the vendored **SheetJS** build (`public/vendor/xlsx.full.min.js`),
  **lazy-loaded** via `_ensureXlsx()` only when an Excel file is chosen (same-origin, so CSP
  `script-src 'self'` allows it). It returns the same 2D string array (ISO dates) the callers
  expect, so `rowsToCsv`→`parseCSV`/`parseAllocationCSV`/`parseMatrixRows` are unchanged. Swapped
  from the old hand-rolled DecompressionStream reader for robustness on arbitrary Excel exports
  (legacy `.xls`, 1904 date system, sheet order). `_extractHeaderDate` accepts ISO + DD/MM/YYYY.
- HTML shell (`/`): **network-first** — always fetches fresh HTML when online, falls back to cache offline
- API routes: **network-only** (never cached), matched by `API_RE`
- Other assets: **cache-first**
- SW registration in the HTML listens for `controllerchange` and reloads the page automatically when a new SW activates after a deploy — no manual cache clearing needed.
- **GOTCHA:** every API resource MUST be listed in `API_RE`. A missing one (this bit
  us with `lifegroups`) falls through to the cache-first asset path and can get the
  SPA HTML cached under its URL, breaking JSON parsing (symptom: "… unavailable").
  When adding a new top-level API route, add it to `API_RE` and bump the cache name.
  This bit us with `audits`: its GET routes fell through to cache-first, so a saved
  audit never re-fetched (symptoms: "audit doesn't persist", "lifegroup data not
  showing" — a snapshot cached before the lgStats fix was served forever). `audits`
  is now in `API_RE` as of `cms-v6`.

## Notifications (web push) — removed

Push notifications were fully removed from the codebase 2026-07-11 and archived to
`../Archive/push-notifications-2026-07-11/` (source + a README with reinstatement notes).
The Supabase `push_subscriptions`/`notifications`/`notification_recipients` tables may
still exist in the database — that's out of scope for this code-only removal.

## Trend qualifiers

- Rising/declining fire only when a stream's attendance **rate** moved **≥ 20 percentage
  points** vs the previous term (raised from 5pts). Threshold lives in **both** the
  backend (`atrisk.service.ts`, `trends.service.ts` groupSummary) and the SPA
  (`isRising`, `_streamQual`, and the CA module rate trends) — keep them in sync.

### Screen rename + operational hardening (2026-07-03)

- **`At Risk & Rising` → `Health`**: new heart icon, subtitle dropped, added a `Stable`
  category for previously-uncategorized students, shrunk card height. `_arQualChips`/
  `qualChips` and the underlying `computeStatus`/`attendQual` model are unchanged — this
  was a rename + display tweak, not a scoring change.
- **Admin**: the Audit tab was removed from Admin Settings (the backend `/admin/audit`
  route and its log are kept, just unreachable from the SPA — nothing in the frontend
  calls it). Deleting an account now requires typing its username to confirm.
- **Connection Audit**: the separate audit-hub and deck-preview screens were deleted;
  the CA tab nav moved to the top of the module and the YTD/term strip was dropped in
  favour of the `scopeBar()` year+period picker described elsewhere in this doc.
- **DB timeout gotcha**: production logs showed `/lifegroups/stats` occasionally hanging
  the full 60s and surfacing a raw Vercel platform timeout instead of a clean error, and
  idle Postgres connections closing after only 10s — shorter than a normal logout-then-
  login pause, forcing every post-login query to reopen a fresh connection. Fix: every
  route now fails fast with a retryable 503 after 20s instead of riding to the platform's
  hard 60s limit (CSV/audit import routes are exempt — they're expected to run long); the
  idle-connection timeout was raised 10s → 30s.

### Bug fixes, New Year Data Refresh wizard, SMS templates (2026-07-04)

- **Connect Setup**: removed the per-leader "N at risk" tile badge (added only the day
  before — turned out not to be wanted).
- **Home**: admin/director's "Attendance by Quad" renamed to **`Youth By Quad`** and
  stripped down to youth-only numbers (no Lifegroups row/columns) — the separate
  "Lifegroups by Quad" section below already covers that, so showing it twice was
  redundant. `_hAttTile` gained an `opts.hideLifegroupRow` flag for this; quad's own
  "Attendance by Grade" tiles (which still show a Lifegroups row) are untouched since
  `_hGradeMini` — the admin/director-only per-grade dropdown renderer — was the only
  thing simplified.
- **Click a lifegroup → see who attended**: added to the main Trends lifegroup tab, the
  Home lifegroup dropdowns (quad/director/admin), and Connection Audit's own Lifegroup
  Health tab. Live-app screens hit a new `GET /lifegroups/:id/members` endpoint
  (`lifegroup-stats.service.ts`); the CA tab reads a `roster` array now included in each
  named lifegroup's per-term stat inside the audit snapshot (`AuditLgStat.roster`,
  `attendance-build.ts`). Audits saved before this shipped won't have a roster until
  re-uploaded/re-finalized. **Gotcha**: the SPA's `_lgCombine()` (merges per-term stats
  into one when the CA scope spans several terms, e.g. "Year to date") rebuilds each
  lifegroup entry from a fixed field list — any new per-lifegroup field (like `roster`)
  needs to be explicitly folded into that merge or it silently disappears whenever more
  than one term is selected, even though a single-term view shows it fine.
- **Connection Audit people tab**: dropped the colored initial-circle avatar; stage/
  year/gender now sit inline with the name on one line instead of two, shrinking row
  height.
- **Connection Audit lifegroup tab + Executive Brief deck**: named lifegroups display
  with a `"Brisbane - YS - "` prefix and trailing `"Lifegroup"` stripped when present
  (`lgDisplayName()`), display-only — underlying data/exports keep the full name. Note
  this is independent of `import.service.ts`'s own `shortName` derivation (which strips
  everything before the *first* `" - "` at import time) — the two aren't composed, so
  `AuditLgStat.name` always uses the un-stripped `fullName`/raw uploaded name to keep
  CSV-audit-upload and live-finalize snapshots displaying consistently.
- **Admin → New Year Refresh** (new 4th Admin tab): a gated, in-order checklist through
  the existing pieces needed to roll into a new year — nothing here is a new capability,
  it's the existing Export/Reset/Import endpoints walked in the one order that actually
  works, since Full Reset deletes the leaders that the allocations import needs to match
  against, and re-importing the lifegroup CSV is what recreates them (`(leader)`-tagged
  names). Steps: (1) Export Allocations CSV + finalize this year's Connection Audit
  snapshot straight from live data (new `ConnectionAuditService.finalizeFromLive`,
  `POST /audits/finalize-live` — reuses `computeYearAggregates`/a live-data variant of
  `buildLifegroupStats`, sourced from live tables instead of parsed CSVs; CRM overlays
  are left empty and a later manual CA upload for the same year overwrites it, same
  idempotent-per-year behavior as the normal upload path); (2) Full Reset (unchanged
  typed-RESET flow); (3) a reminder card to re-import attendance CSVs, unlocked by an
  explicit "I've done this" acknowledgement (no reliable server-side signal for this);
  (4) Import Allocations. Wizard state is in-memory only — re-opening the tab always
  starts fresh.
- **Removed "Save Defaults"**: it wrote a snapshot of accounts+leaders to an `app_defaults`
  table that nothing in the codebase ever read back (no restore path existed anywhere) —
  dead write-only functionality that didn't fit the refresh flow above. Removed the
  button, route, service method, `ISnapshotRepository` + both implementations, and the
  `AppDefaults` entity; dropped the `app_defaults` table (migration `015`).
- **Call-sheet SMS templates**: `callPhone`/`phoneLink` gained an optional `firstName`
  param (all 6 call sites updated). The action sheet is now Call / Message (default
  `"Hey {first name} "` via an `sms:` `body=` param) / **Message Custom** (shown only
  when the device's self-identified leader, `getMyLeaderId()`, has a saved template) /
  Cancel. New `Leader.smsTemplate: string | null` (migration `014`), with a placeholder
  `<first name>` substituted case-insensitively at send time. Saved via a **dedicated**
  `PATCH /leaders/:id/sms-template` endpoint rather than the general leader `update()` —
  the general endpoint's ownership checks (grade logins can only edit leaders *they*
  created) would reject most self-identified leaders, since most are auto-created by CSV
  import (`createdByGrade: null`); there's no server-verified binding between an Actor
  and "the leader they identify as" anyway, so the template — a low-stakes preference,
  not an RBAC-sensitive field — skips that check. Editable from a new box under the Home
  Follow Up section. **`sms:` URL gotcha**: `encodeURIComponent` does not escape `'`
  (it's a valid URI char), so a name/template containing an apostrophe (e.g. "D'Angelo")
  would break out of the single-quoted JS string in the `onclick` attribute — `_smsHref()`
  manually replaces `'` → `%27` after encoding, the same reason `phoneLink()`'s raw digits
  are stripped of `'`/`\` before interpolation.

### Home-load performance investigation + fixes (2026-07-05)

Investigated persistent "home screen is slow" / login-hiccup reports. Seven days of Vercel
logs showed this wasn't a chronic drip — every failure (7×503 + 1×504) clustered in one
~7-minute window, all triggered by a single `POST /import/group-csv` call that hit Vercel's
60s hard function timeout while it held connections other concurrent requests needed.

- **`statement_timeout` wasn't actually being enforced.** `client.ts`'s `postgres()` config
  sets `connection: { statement_timeout: 15000 }`, but the driver only sends this once, as a
  Postgres wire-protocol startup parameter — it isn't re-applied per query. Through Supabase's
  Supavisor **transaction-mode** pooler, the physical backend behind a client connection can
  change between transactions, silently dropping that setting after the first one. Live
  evidence: a trivial 24-row `select * from lifegroups where id = $1` was caught in
  `pg_stat_activity` **actively running for 4+ minutes**. Fixed at the database role level
  instead — the same pattern Supabase's own `authenticator`/`anon` roles already use (they carry
  `statement_timeout` in `rolconfig`): `ALTER ROLE postgres SET statement_timeout = '15s'`,
  enforced by Postgres itself regardless of pooling mode. **This is a production DB config
  change, not in the codebase or migrations** — if the DB is ever recreated, re-apply it.
- **Redundant DB fan-out on every Home/Trends load.** Home fires 5 parallel HTTP requests
  (`/overview`, `/trends`, `/students`, `/lifegroups/stats`, `/connections`); Trends fires an
  overlapping 4. Between them they independently re-fetch the same full tables —
  `studentRepo.findAll()` alone ran 4 separate times for one Home load. Fixed two ways:
  - **In-flight de-dupe** (`src/utils/inflight-dedupe.ts`, `dedupeReads()`): concurrent callers
    of the same no-arg repo read (`findAll`/`getSettings`/`findActive`) now share one in-flight
    promise instead of firing duplicate queries. Applied once, centrally, in `container.ts` at
    repo-construction time — Supabase repos only, in-memory test repos are untouched. Safe
    because none of these reads vary by caller; actor-scoping happens after the fetch, in the
    service layer.
  - **`overview.service.ts` now caches like the other two stats services.** It was the only one
    of the three (`trends.service.ts`, `lifegroup-stats.service.ts`, `overview.service.ts`) with
    no `ResponseCache`. Mirrors their exact pattern (60s TTL, actor-keyed via the now-shared
    `src/services/actor-key.ts` — previously duplicated verbatim in both other files).
    Invalidated on every write that changes students/leaders/connections: both
    `import.service.ts` call sites, `connection.service.ts`'s `assign`/`unassign`/
    `importAllocations`, and — a pre-existing gap found while auditing this — `admin.service.ts`'s
    `reset()`/`clearServiceGroupData()`, which previously invalidated **none** of the three
    stats caches (a full data wipe could leave Home showing pre-wipe numbers for up to 60s).
    **Known accepted trade-off**: invalidation is still manually sprinkled per mutation, not
    centrally enforced — a future write path that forgets to call `invalidate*Cache()` will
    silently serve stale data for up to 60s. Each of the three has a comment flagging this.
- **`importGroupCsv` had more round-trips than its data volume justified** (677 students / 24
  lifegroups / 2894 attendance rows shouldn't take 60+ real seconds). `lifegroup_attendance`
  cascades from BOTH `lifegroups` (`lifegroup_id` FK) and `lifegroup_weeks` (`week_id` FK) on
  delete cascade, so the explicit `lifegroupAttendanceRepo.deleteAll()` run before the other two
  truncates was provably redundant — dropped it, and the remaining two truncates now run
  concurrently. Leader saves went through one `save()` call per leader — added
  `ILeaderRepository.saveMany` (mirrors `SupabaseStudentRepository.saveMany`'s chunked bulk
  upsert) and switched `importGroupCsv` to one bulk call. Merged two sequential read
  `Promise.all` batches into one (nothing forced the split). **Explicitly not done**: wrapping
  the import in a `sql.begin()` transaction for atomicity — a killed/crashed import can still
  leave lifegroup tables truncated-but-not-repopulated. Flagged as a follow-up, not fixed here.
- **Upload spinner**: `uploadServiceImport`/`uploadGroupImport` (Import tab) now show the
  existing `.spin` element (same class already used for the parsing/reading phase) during the
  "Uploading…" status, plus a module-level `_importBusy` guard against a second concurrent
  import — the confirm modal closes immediately on click, before the upload starts, so
  re-parsing and re-confirming a file mid-upload could otherwise fire a second request.

New tests: `src/tests/overview.service.test.ts` (cache hit + invalidation), plus a case in
`import.service.test.ts` asserting leader saves go through `saveMany` once, not `save()` N times.

### Removed "click a lifegroup → see who attended" from the main app (2026-07-05)

The feature added the day before (Home lifegroup dropdowns + the main Trends lifegroup tab)
was pulled back out: it wasn't a useful part of the workflow there, and `getMembers` was
**self-contained and per-click** — every click re-fetched full `students`/`lifegroupWeeks`/
`lifegroupAttendance`/`sessions` tables and recomputed term boundaries from scratch rather than
sharing `get()`'s cached closure, so it was a real (if intermittent) load spike on Home/Trends,
consistent with the slowness reports.
- `GET /lifegroups/:id/members` route, `LifegroupStatsService.getMembers`, and the controller
  method are deleted (dead once the only caller was removed). `_lgGroupRow` (Home/Trends) is
  back to a plain, non-clickable row.
- **Connection Audit's own Lifegroup Health tab is untouched** — it never called this endpoint.
  `CA.showLgRoster()` reads `roster` straight off the loaded audit snapshot (already in memory),
  so the "who attended" capability still lives there, which is where it was ported from
  originally.

### Home follow-up timeout fix (2026-07-05)

Production logs (Vercel runtime logs, post the fan-out/caching fixes above) still showed
occasional 20s timeouts on `GET /connections/leader/:id/followup` — the Home "Follow Up"
leader-picker endpoint. Unlike the Home fan-out (5 endpoints fetched in one `Promise.all`),
`FollowupService.leaderFollowup` (`followup.service.ts`) chained its reads **sequentially**:
`findById`/`findByLeader`/students `findAll` (already parallel) → `sessionRepo.findValid()` →
conditionally `svcAttRepo.findBySession()` → `weekRepo.findAll()` → conditionally
`grpAttRepo.findAll()` — up to 6 round-trips end to end, holding a pooled DB connection open
for the sum of their latencies instead of the max. Fixed by moving the 5 mutually-independent
reads (leader, connections, students, valid sessions, weeks, lifegroup attendance) into one
`Promise.all`; only `svcAttRepo.findBySession()` still runs after, since it needs the latest
session's id from the batch first. Same root cause and same fix shape as the Home/Trends
fan-out fix, just on a different (click-triggered, not initial-load) endpoint — the global
`#nprog` bar is reference-counted across every API call, so a slow endpoint triggered by an
on-page interaction (the follow-up picker, the now-removed lifegroup click-through) reads to
the user as "Home is still loading" even though Home's own initial fetch already finished.

### Production performance incident — full history + handoff for independent review (2026-07-05)

**For a fresh Claude instance picking this up.** The user has asked for an independent
review/continuation of an ongoing production performance incident. Read this whole
section before touching code — it's the complete history so far, not just the latest
state.

**Symptom timeline:**
1. A "click a lifegroup → see who attended" feature was added to the live app (commit
   `bb3a932`, 2026-07-04), then removed the next day (`a3f10b8`) because its `getMembers`
   endpoint re-fetched full tables per click and was a load spike. **Confirmed by grep +
   diff against pre-feature code: no residual code from this feature remains in any
   live-request path** (`lifegroup-stats.service.ts`, `import.service.ts`,
   `attendance-build.ts` all checked). The only surviving change is a `roster` field used
   solely by the Connection Audit snapshot builder (on-demand, pure in-memory JS, not
   called during Home/Trends/lifegroup-stats requests) — **rule this theory out**, don't
   re-investigate it.
2. Real issue: `GET /overview`, `/students`, `/trends`, `/lifegroups/stats`, and
   `/connections/leader/:id/followup` started intermittently hitting the 20s route
   timeout → 503, all together, unrelated endpoints at once.
3. **2026-07-05, later same day**: after several fix attempts (below), the user reports
   the app "at least loading" but **very slow, and not showing all the data when it does
   load**. This last symptom (partial/incomplete data on a page that does render) is
   **new and not yet root-caused** — see "Open questions" below.

**Target end state**: page loads **under 5 seconds** per screen, with **30-40 leaders
using the app simultaneously** (this is a small church youth ministry team, not a
high-traffic consumer app — the DB is tiny: ~677 students, ~22k service_attendance rows,
~2.9k lifegroup_attendance rows. The infra ceiling, not data volume, is the constraint).
**Constraint: Supabase free tier** — user has explicitly said no upgrade for now, so
`max_connections=60` and whatever Supavisor's free-tier pool size is are hard limits to
design within, not levers to pull.

**Root cause (confirmed via live diagnostics, not guessed):** `withTimeout()`
(`src/utils/timeout.ts`) rejected on its 20s deadline but didn't stop the underlying DB
query. Each serverless instance only has `max: 2` Postgres connections
(`src/repositories/supabase/client.ts`). An abandoned query kept a connection tied up
indefinitely; any later request that got scheduled onto that same connection queued up
behind it — that's why unrelated endpoints failed together. Confirmed live: a query
dispatched fast but not actually returning for ~19-99s while sitting behind another
query on the same connection, and a driver-level `Postgres.js : Unknown Message` protocol
desync consistent with a connection being reused while still processing abandoned work.

**Diagnostics added (kept, still deployed, safe to leave in place)**:
- `src/utils/request-context.ts` — an `AsyncLocalStorage`-based per-request context
  (id, route, start time, and a `pendingQueries` set).
- `src/api/http/express-adapter.ts` — logs `[reqtiming] <id> <route> start/done/failed`
  around every route.
- `src/repositories/supabase/client.ts` — postgres.js's `debug` hook logs
  `[db-dispatch] conn=<n> <id> <route> +<ms> :: <query>` whenever a query is actually
  handed to a connection (never logs bound parameters — PII).
- Read these via `vercel logs <deployment-url> --json` (or the production alias
  `https://ys-connection.vercel.app`) filtered on `reqtiming`/`db-dispatch`.
  This is by far the fastest way to get real evidence instead of guessing — use it
  before proposing any fix.

**Fix attempts, in order, with results:**

| # | Commit(s) | What it did | Result |
|---|-----------|-------------|--------|
| 1 | `b8703a9`, `68075a2`, `887c230` (earlier session, same day) | Parallelized `leaderFollowup`'s reads; added a client-side retry-once-on-503; lowered pool `max` 5→2, raised `idle_timeout`/`max_lifetime`, staggered Home's prefetch | **Did not stop the incident** — confirmed still failing minutes after deploy (see `plannedupdate.md`, written at the time as a same-day handoff) |
| 2 | `704f84c` | Added the diagnostics above (no behavior change) | N/A — instrumentation only, this is what made the rest possible |
| 3 | `ad848fc` | `withTimeout` now cancels a request's in-flight queries (postgres.js's real `query.cancel()`) via the `pendingQueries` set, instead of abandoning them | **Partial fix.** Confirmed live: `.cancel()` only hard-aborts a query that's the one *actively* being processed on its connection right now; one already sent but queued behind another query on the same connection just gets soft-marked and keeps waiting its turn — one request's queries were re-dispatched ~79s after being "cancelled" |
| 4 | `bf395e5` (**reverted** by `6c4bc04`) | Escalated to force-destroying the whole DB client on timeout | **Regression, caught within ~5 min and reverted.** `api/index.ts` caches the built app/container once per warm serverless instance; `container.ts` passes the `sql` client into every repository once at that same time. Destroying the module-level singleton never reached those already-built repos, which kept a dead reference — every subsequent query on that instance failed instantly with `CONNECTION_ENDED` |
| 5 | `ade64a6` (current) | Same goal as #4, different mechanism: `getSqlClient()` now returns a **permanent stable proxy** that repos capture once as always, but every call through it re-resolves the *real* underlying client at the moment of use (`getRealClient()`). `destroySqlClient()` only swaps what's underneath — no repo/container/api change needed. Verified against a standalone Node simulation of the exact "capture once, then destroy, then reuse the same reference" scenario that broke #4, *before* wiring it into the real client | **Confirmed working better, not fully clean.** Live traffic post-deploy: 0 full 20s timeouts (down from ~30 in an equal-length window right before), 0 `CONNECTION_ENDED` cascades (regression from #4 confirmed gone), but 6 `CONNECTION_DESTROYED` fast-fails (< 400ms) — expected collateral: destroying a stuck connection also fails any other request using that exact connection at that instant. Surfaces as a 503, which the existing retry-once-on-503 (`68075a2`) should mask client-side. Connection IDs climb steadily post-destroy (2→3→6→7→10→11), confirming recovery is clean |

**Open questions for the reviewer:**
1. **"Not showing all the data when it does load"** (reported after fix #5 was live) —
   not yet investigated. Hypotheses to check first: (a) the SPA's `Cache`/stale-while-
   revalidate pattern (`public/index.html`, 30s TTL) rendering a page from a partial set
   of the parallel fetches if one sub-request 503'd and the retry-once logic didn't cover
   it, while others succeeded; (b) `dedupeReads()` (`src/utils/inflight-dedupe.ts`)
   sharing an in-flight promise across concurrent callers — if that shared query's
   connection gets destroyed mid-flight, does *every* caller sharing it get a clean
   error, or does one silently get a partial/wrong result? (c) whether the CSV import's
   own long-running connection (`UNTIMED_ROUTES` in `express-adapter.ts`) could itself be
   the thing occupying a connection that then gets force-destroyed by an unrelated
   request's timeout, corrupting the import. Start from the `[reqtiming]`/`[db-dispatch]`
   logs on a real repro, don't guess.
2. **Residual delayed dispatches**: a handful of `[db-dispatch]` lines still show a query
   for an *already-completed* request dispatching many seconds late (observed up to
   +9674ms). Not currently blocking new requests (they get a fresh connection instead of
   queuing), but not fully explained — likely an abandoned query left running in the
   background until its connection is eventually destroyed by someone else's timeout.
3. **Whether `max: 2` connections is still the right number** given the actual target is
   30-40 *simultaneous* leaders — this was tuned down from 5 during fix attempt #1 to
   reduce connection-acquisition burst, but with the stable-proxy destroy mechanism now
   in place, it may be worth re-measuring rather than assuming 2 is still optimal.
4. Whether `<5s per screen` is achievable at all on the free-tier connection ceiling
   without also reducing the number of round trips per page — Home/Trends already fan
   out 5-9 parallel requests per load (see the "Home-load performance investigation"
   section above); each of those still does several sequential-ish queries internally
   (see the `[db-dispatch]` traces in this section's history for `/lifegroups/stats`,
   `/trends`, etc.). Consider whether the real fix is architectural (fewer, cheaper
   queries per screen, e.g. the precompute plan in `plannedupdate.md`) rather than
   further connection-pool tuning.

**Also read**: `plannedupdate.md` (untracked, in the repo root) has the same history in
more granular, chronological form, including a separate precompute proposal
("attended latest service/lifegroup at import time") that would reduce
`leaderFollowup`'s query count independent of the connection issue above.

### Incident continuation — DEFINITIVE root cause found + batch fix shipped (2026-07-05, independent review)

A later session independently reviewed the above against **live evidence** (Vercel runtime
logs + a controlled load test against production using a real grade login) instead of trusting
the prior conclusions. Findings, in order:

1. **The prior "verified fixed" (`ade64a6`) was a false positive.** Live logs showed a fresh
   503 cluster still firing under real traffic; the `CONNECTION_DESTROYED` fast-fails were NOT
   all sub-400ms (several were 5–10s). The destroy-on-timeout hook was **amplifying** the
   cascade: one request's timeout called `destroySqlClient()`, force-ending the shared client
   and killing OTHER concurrent requests' in-flight queries.

2. **Reverted the incident-era escalations toward the sister Camp Platform's proven-simple
   config, then load-tested each step:**
   - Removed the destroy-on-timeout hook (`app.ts` no longer wires `onRouteTimeout`). Relies on
     the role-level `statement_timeout=15s` (confirmed applied on the prod DB) like the Camp app.
   - Tried `max:2→5` (to match Camp) — **load testing proved this WRONG for CMS** and it was
     reverted back to `max:2`. See next point.

3. **TRUE root cause #1 — Supavisor free-tier CLIENT-connection cap (`EMAXCONN`, limit 200),
   not `max_connections=60`.** Under a concurrent burst Vercel spins up many instances; total
   pooler connections = `instances × max`, so `max:5` hit the 200 ceiling ~2.5× sooner than
   `max:2`. Pool tuning **cannot** solve the target concurrency — the lever is fewer requests
   per page (each Home load fanned out 5–9 requests → 5–9 invocations → instances → connections).

4. **Shipped `GET /batch` (`ff9b2ac`) — the structural fix for the fan-out.** Composes the
   existing services (`overview/trends/students/lifegroupStats/connections/atRisk/settings/
   leaders`) into ONE request via `Promise.allSettled` (graceful partial render; `dedupeReads`
   now coalesces shared table reads across sections). SPA: `API.batch(paths)` fetches the
   batchable paths in one `/batch` call and **seeds the client cache under each path's own key**,
   so every screen renderer is unchanged; `_prefetch`, all 9 `_revalidate<Page>` helpers, and
   `renderHome`'s cold branch now batch. `sw.js` `API_RE` gains `batch`; cache `cms-v21→v22`.
   **Verified in-browser** (login + Home + Trends render, console clean, each screen = 1 batch
   request, zero individual fan-out) and **190+7 tests pass**. This **eliminated the `EMAXCONN`
   500s**. Endpoint is additive — every standalone endpoint still works; easy revert.

5. **TRUE root cause #2 (the deepest one) — abandoned transactions LEAK Supavisor backend
   slots.** After batch, the pooler still saturated under a simultaneous cold burst. Traces
   showed only 2 queries dispatch per batch (`max:2`) then **20s of silence**. `pg_stat_activity`
   revealed why: queries stuck **`state='active'`, `wait_event='ClientRead'` for 4–9 MINUTES** —
   the Postgres/pooler backend waiting on a client (the Vercel function) that already died on its
   20s timeout. `statement_timeout` can't reap these (they're not executing SQL). They accumulate
   until the pooler's backend pool is exhausted → every endpoint 503s together → each 503 orphans
   another query → **death spiral**, slow to recover (minutes). This is the real mechanism behind
   the whole incident — "unrelated endpoints fail together" = shared exhausted pooler.
   - **Operational remedy** if the pooler is ever saturated by orphans (symptom: even a single
     `/auth/login` takes 20s→503 while `/health` is fine): terminate them in the Supabase SQL
     editor —
     ```sql
     select pid, pg_terminate_backend(pid), now()-query_start
     from pg_stat_activity
     where state='active' and wait_event='ClientRead'
       and pid<>pg_backend_pid() and now()-query_start > interval '60 seconds';
     ```
     (Claude cannot run `pg_terminate_backend` — it's blocked as a destructive prod-infra action;
     the human must run it.)

**Remaining work (the real fix for root cause #2 — NOT yet done):**
- **Stop the leak at the source (server-side reaping).** `statement_timeout` doesn't cover an
  abandoned `active`/`ClientRead` backend. Investigate + apply the right reaper: Supavisor pooler
  `client_idle_timeout` (Dashboard → Database → Connection Pooling) and/or aggressive TCP
  keepalives; `idle_in_transaction_session_timeout` at the role level covers the
  idle-in-transaction variant. Goal: orphaned backends reaped in seconds, not minutes.
- **Remove the write-on-every-read.** `SupabaseSettingsRepository.getSettings()`
  (`supabase.settings.ts:62`) runs an `insert into app_settings … on conflict do update` on
  EVERY call (it was one of the stuck queries). Make it `SELECT` first, insert the default only
  if missing — removes a write (and a heavier transaction to orphan) from every stats request.
- **Precompute the heavy aggregates** (`plannedupdate.md` + extend to trends/overview/
  lifegroup-stats): each stats load scans full tables (`service_attendance` ~22k rows) in JS;
  precomputing into a small table at import time makes reads one cheap indexed query, cutting
  both query cost and the window for a timeout→orphan.
- **Re-verify with a STAGGERED-arrival load test** (users over ~15s, not one instant). The
  single-client herd test overstates instance concentration; real spread-out usage may already
  be acceptable with batch alone. (Note: heavy load testing orphans transactions and degrades
  prod — always clear orphans afterward with the SQL above, and prefer gentle staggered tests.)

Load-test scripts live in the session scratchpad (`loadtest.mjs` = per-endpoint fan-out,
`loadtest-batch.mjs` = post-fix batch pattern, `loadtest-realistic.mjs` = staggered arrivals).
Test login used: `grade11b`. Current live state: `max:2`, no destroy hook, `GET /batch` shipped,
diagnostics still in place.

### ✅ RESOLVED — the actual root cause was the pooler CONNECTION MODE (2026-07-06)

A further independent review (again driven by live evidence — Vercel runtime logs,
`pg_stat_activity`, direct `EXPLAIN ANALYZE`, and in-browser reproduction) found that the
whole multi-day incident had **two distinct causes, neither of which was the app code,
the data, or the earlier "orphaned transaction / pool exhaustion" theory** (that was a
downstream *symptom*, not the disease). Both are now fixed and deployed.

**How it was isolated (the decisive evidence):**
- Rolling the app all the way back to the pre-incident commit (`6ecbc76`) did **not** fix
  it, and a full Supabase project restart did **not** fix it → it was neither the app code
  nor a transient pooler state.
- The database itself was proven healthy: `select * from service_attendance` (all ~22k
  rows) runs in **4.5 ms**; `pg_stat_activity` showed ~10/60 connections, no locks, no
  stuck queries; backends execute every query in <1 s and go idle.
- Yet the app hung: `[db-dispatch]` traces showed queries dispatched to the wire in ~1 ms,
  then **20 s of silence → route timeout → 503**. The hang was **intermittent and tied to
  establishing a NEW connection** (it died on fresh `conn=3`, mid `pg_type` init). Warm,
  already-established connections were always fast (12/12 logins at ~0.5 s).

**Root cause #1 — the outage: transaction-mode Supavisor pooler intermittently hands back
DEAD connections.** On the free-tier **transaction-mode** pooler (port `6543`), a
newly-established connection was occasionally TCP-connected + authenticated but **never
returned a response to any query on it** — so the request hung to the 20 s timeout. This
spikes exactly when 30–40 leaders arrive at once (a burst of cold starts / new
connections). The earlier "abandoned transactions leak backend slots" was the death-spiral
this *triggered*, not the origin.
- **Fix (shipped): switch the pooler from transaction mode to SESSION mode.** In the Vercel
  `DATABASE_URL`, change the pooler port `6543` → **`5432`** (same host/user/password).
  Session mode gives each connection a dedicated backend for its lifetime and does not
  exhibit the dead-connection behaviour. Verified live: `/overview`, `/trends`,
  `/lifegroups/stats`, `/auth/login` all went from 503@20 s to **200 in <1 s**. This is the
  single change that ended the outage.

**Root cause #2 — a separate, long-standing login lockout: the login rate limiter was keyed
by RAW IP.** `express-adapter.ts` limited logins to 10 per IP per 15 min (in-memory). The
real audience is 30–40 leaders behind **one shared church/school NAT IP**, so the whole team
collectively got 10 logins / 15 min → everyone past that got a 15-min `429`. Present in every
version (so rollback couldn't remove it) and in-memory (so a DB restart couldn't clear it),
which is why it masked/compounded the outage.
- **Fix (shipped, `664e9f7`): re-key the limiter by IP + account** (falls back to IP-only if
  username absent) and raise the per-account cap to 30/15 min. Per-account brute-force protection
  is retained; it's best-effort throttling, not a hard boundary.

**Also done in the same pass:**
- **RLS enabled** on the four tables that migration 006 missed (`connection_audits`,
  `notifications`, `notification_recipients`, `push_subscriptions`) — see migration
  `016_enable_rls_remaining.sql`. Safe because the app connects as the `postgres` owner and
  bypasses RLS (the other 12 tables already ran this way).
- **Incident diagnostics removed** now that the cause is known: the `[reqtiming]` logs
  (`express-adapter.ts`), the `[db-dispatch]` postgres.js `debug` hook (`client.ts`), and the
  unused `destroySqlClient()` / `TimeoutHook` machinery. The 20 s route timeout and the
  per-request query-cancellation were **kept** (they're safety nets, not diagnostics).

**Session-mode trade-off + mitigation levers (if the connection ceiling is ever hit).**
Session mode holds a dedicated backend per app connection (transaction mode multiplexed
them), so the ceiling is `max_connections = 60`. At current usage this is comfortable (~5–20
of 60), and it should still serve 30–40 leaders because connections are per *Vercel instance*
(not per user — Fluid Compute packs many users onto few instances at `max: 2` each) and the
`GET /batch` endpoint already cut requests-per-screen. **If a real Friday-night session ever
approaches the limit** (symptom: new connections failing / queueing under peak load), the
levers, in order of preference:
1. **Lower the app's `idle_timeout`** in `client.ts` (currently 120 s) so idle backends free
   their slot faster — more headroom without touching infra. (Reconnects are cheap + reliable
   in session mode, unlike the transaction-mode dead-connection issue we escaped.)
2. **Raise the Supavisor Pool Size** (Supabase Dashboard → Database → Connection Pooling),
   staying under `max_connections = 60`.
3. **Keep the app's `max` low** (currently 2) so total held backends = instances × max stays
   bounded.
Do **not** stress-test production to find the limit — heavy load testing is what degraded the
pooler during the incident. Watch the connection count during a real session instead.

### Small bug/polish punch list (2026-07-06)

- **Student Search table**: desktop `.dt` table headers are now clickable to sort (Name, Gr,
  Gender, DOB, Youth, Lifegroup, Status); Youth/Lifegroup sort by this-term % only (last-term
  stays a comparison, not a sort key), Status sorts worst-first (stopped/declining ahead of
  stable/rising). The **Quad** chip is removed from both the desktop table (its own column) and
  the mobile card (was inline in the `li-sub` line) — grade + gender already identify it.
- **Connection Audit "Stage 1" renamed to "Interacted"** everywhere it appears — the `STG` label
  map, the Integration ladder / funnel rung labels, the People-tab stage filter dropdown, and the
  executive brief's per-quad funnel viz + methodology slide. A new `helpTip` next to the
  Overview's "Interacted" rung explains it: "Everyone who attended a service, attended a
  lifegroup, or submitted a New Connect/Decision form."
- **People tab per-student badge**: the chip on each person's row (list + detail popup) changed
  from "Stage 1 · First contact" to a compact `STG_SHORT` form — "1 - Interacted", "2 - Youth",
  "3 - Regular", "4 - Lifegroup", "5 - S-Team". The Stage filter dropdown keeps the old
  "Stage N · Label" format (just with the renamed word).
- **Tooltip clipped on a widescreen laptop**: `_clampTip()` only clamped against the raw
  viewport, but `.pg` caps at `max-width:1000px` and centers itself — on a wide screen there's a
  dead zone between the true viewport edge and `.pg`'s own edge, and `overflow-x:clip` on
  `.pg`/body/html silently sliced off any popup that fell in it (worst case: the scope bar's
  Year tooltip, whose "?" sits close to `.pg`'s left edge on every Connection Audit page). Fixed
  by clamping against the nearest ancestor with clipping/scrolling overflow instead of the
  viewport.
- **Parent-number SMS default message**: `phoneLink`/`callPhone` gained an `isParent` flag (all 6
  call sites updated — the 2 that fall back between `mobile`/`parentPhone` pass
  `!s.mobile && !!s.parentPhone`). Tapping a parent's number now defaults the Message text to
  "Hey, `<First Name>`'s leader here, " instead of "Hey `<First Name>` ".
- **Funnel wording**: rung 4's label changed from "Attended a lifegroup this term" to "Attended
  a lifegroup this period" (shared `rungs` array, so this also updates the Overview's
  Integration ladder — the same wording covers both a single-term view and Year-to-date).
- **Fixed: Overview's "In a lifegroup" tile vs. the Integration ladder's "Attended a lifegroup"
  rung showed different numbers.** Root cause: `model()`'s `stage` calc promoted any active
  Student Team member straight to stage 5, *regardless of whether they currently attend a
  lifegroup* — so the ladder's cumulative "stage ≥ 4" count (rung 4) included team members with
  `gA===0`, while the Overview tile (`students.filter(s=>s.gA>0)`) correctly didn't. This wasn't
  a double-counting-multiple-lifegroups bug (each student's `gA` is already a single summed
  attendance count, term-scoped, independent of how many named groups they attended) — it was
  team status silently overriding the lifegroup check. **Fix**: stage 5 now additionally
  requires `gA>0` (`(teamActive&&s.gA>0)?5:...`), matching the ladder's own documented "counts
  people at that stage or beyond" semantics, so `stage>=4` and the "In a lifegroup" tile now
  agree for every matched student. Side effect (intentional): a team member NOT currently in a
  lifegroup now shows their true highest reached rung (e.g. "3 - Regular") instead of "5 -
  S-Team" on their People-tab badge — this surfaces exactly the "on team but disengaged from
  their lifegroup" case the audit is meant to catch, rather than masking it. `p.team` (used by
  the person-detail "Journey" popup and the executive brief's `teamN`, now computed directly as
  `m.people.filter(p=>p.team).length` instead of the old `atLeast(5)`) still reflects true team
  roster membership regardless of this reclassification, so "how many serve on Student Team"
  in the executive brief is unaffected. **Edge case closed on request**: an audit-only
  team-roster entry with no matching platform student (`caOnly` people, `s===null`) has no `gA`
  to check at all, so it used to still be promoted to stage 5 unconditionally. Capped at stage 1
  instead (there's no way to confirm they're currently in a lifegroup), so rung 4 can never run
  ahead of the "In a lifegroup" tile even with an unmatched Team CSV name. `team:true` is
  unaffected, so they still show as team in the person-detail Journey popup and in `teamN`.

### Admin/Connect Setup punch list + New Year Refresh audit backup/restore (2026-07-09)

- **New Year Refresh wizard reworked to 6 steps.** Step 1 ("Export & Finalize Baseline")
  used to both export allocations AND call `finalize-live` — split so step 1 is just
  "Export Allocations". New step 2 "Export Configuration Audit Data" downloads the
  **entire `connection_audits` table** as one JSON file (`GET /audits/export-all`) before
  step 3's Full Reset wipes it; new step 6 "Re-import Configuration Audit Data" restores
  it after step 5 (`POST /audits/import-all`, upserts by year id). Both routes are
  admin-only and registered **before** `/audits/:year` in `router.ts` — Express matches
  routes in registration order, so a param route registered first would swallow the
  static ones.
- **Full Reset now also wipes `connection_audits`.** Previously a Full Reset left last
  year's frozen audit snapshots (which contain per-student rows) behind — silently
  defeating the point of a "full" reset. `admin.service.ts`'s `reset()` now also
  `findAll()` + `delete()`s every row in that table.
- **Self-service password change**, distinct from the admin's existing "reset another
  account" flow: `POST /accounts/me/password` (verifies current password, no
  `admin:manage` needed — any authenticated actor can change their own). Key icon on
  Connect Setup, next to Export CSV. The admin's own "Reset password" flow (Accounts tab)
  now shows the new password **once**, in a copyable box — there's no way to retrieve it
  later since it's bcrypt-hashed one-way.
- **Connection Audit funnel bug — CRM overlays wiped by a partial re-upload.** The Data
  tab's `saveAudit()` replaces the WHOLE year's snapshot; if the admin re-uploaded just
  Service/Group attendance without also restaging Team/Connect/Decision/Flows, those
  overlays silently reset to `[]` (Zod defaults), collapsing the "Interacted" funnel rung
  down to equal "Came to Youth" (the only source of stage-1-only people is
  `hasConnect`/`hasDecision` marks + unmatched `caOnly` names). Fixed with a `carry()`
  fallback in `saveAudit()`: an unstaged slot now falls back to `AUDIT.uploads.<kind>`
  from the currently-loaded year instead of defaulting to empty; the Data tab UI shows
  "N rows carried over from `<year>`" so it's not silently invisible.
- **Quad funnel breakdown couldn't see unmatched people, even after the fix above.**
  `rFunnel()`'s per-quad panel filtered on `p.s && p.s.quad===q` — an unmatched
  (`caOnly`) Connect/Decision submitter has `p.s===null`, so they were structurally
  excluded from every quad's breakdown even though the overall funnel counted them. Since
  the Connect/Decision CRM export actually carries grade + gender columns, `parseRows`/
  `parseMatrixRows` now read them (optional — absent on exports that don't have them), and
  every `people.push(...)` (both matched-student and `caOnly`) now carries a `quad` field
  — computed via a client-side `computeQuad(grade, gender)` (mirrors
  `src/core/types/enums.ts`) for `caOnly` people, straight from `s.quad` for matched ones.
  All 4 quad-filtering call sites (`rFunnel`, the People tab's quad filter, the exec
  brief's `quadFunnelViz`) now read `p.quad` instead of `p.s.quad`. The one exception,
  `exportQuad()`'s follow-up CSV export, still requires `p.s` truthy — it dereferences
  `p.s.gT`/`p.s.grade`/`p.s.ph`, which only a matched student record has.
- **Leader self-service grade broadening, gender stays locked.** A grade/quad login
  editing a leader (Connect Setup's pencil icon) can now check grades outside their own
  bracket, so they can see and connect students from those grades too — same rationale
  as the SMS-template carve-out: most leaders are auto-created by CSV import
  (`createdByGrade: null`), so the general `update()` endpoint's ownership check would
  otherwise reject almost everyone. New `PATCH /leaders/:id/grades` /
  `LeaderService.updateGrades()` skips that check entirely and only ever touches
  `grades`. In the Edit Leader modal, `lockGender = role==='grade'||role==='quad'` shows
  gender as a disabled, read-only select for those two roles (admin/director unaffected);
  `submitEditLeader()` sends grades through the new endpoint (always succeeds) and
  name/active best-effort through the general endpoint (silently skipped if you don't own
  the leader — that's a pre-existing restriction, not a regression).
- Also: Data tab gained a "Go to Import" shortcut; allocations export is now date-stamped
  (`allocations-YYYY-MM-DD.csv`, matching the audit backup file); `.pg`'s bottom padding
  halved (was `76px`, pure dead space on desktop where the mobile bottom-nav it was
  clearing doesn't even render); the Connect Setup "Add Students" picker no longer
  repaints the page behind it on every single add/remove (only once, on close) — the
  per-toggle repaints were clobbering the admin's scroll position; Health tab cards gained
  a profile-icon button; student profile's "Leader Assignments" dropped the redundant
  "Connect →" button and the "search a leader to assign" results list (not the already-
  connected list) got the same capped-scroll treatment as Connect Setup's student
  preview, with gender/grade dropped from each row.
- **Add Students picker now actually offers a broadened leader's other grade(s).**
  `updateGrades` (above) only ever touched the *Leader* record's `grades` — but the
  picker's underlying student pool came from `GET /students` (and the leader-card counts
  from `GET /connections`), both server-scoped by the *actor's own* single
  grade/bracket (`student.service.ts`'s `list()`, `connection.service.ts`'s `listAll()`).
  So broadening a leader to a second grade didn't change what the picker could even see —
  the other grade's students never reached the client. Fixed with a `crossGrade` filter
  flag: when true, `list()`/`listAll()` swap the "own grade/bracket + own gender" check
  for "own gender only" (the same relaxation `assign()`, `student.service.ts`'s
  `get()`/`search()`, and the CSV export already applied — see the "cross-grade connect
  exception" comments). Wired as two extra `/batch` sections (`studentsConnect`,
  `connectionsConnect`) and two dedicated cache keys (`/students?crossGrade=1`,
  `/connections?crossGrade=1` — `Cache.del()` now also matches `?`-suffixed variants of a
  base path) so Health/People/Data/Trends/Birthdays/My Students keep the narrower,
  grade-scoped `/students` and `/connections` untouched — **only** Connect Setup's own
  `CONNECT_PATHS` requests the widened variant. `exportCsv` (Connect Setup's "Export CSV"
  button, the only caller) got the same own-gender-only swap, unconditionally, so a
  leader's cross-grade connections don't silently vanish from their own export either.
  Within each of the picker's three buckets (not assigned / assigned elsewhere / assigned
  here), students now sort with the logged-in login's own grade(s) first
  (`_pickByOwnGradeFirst`, derived from `S.user.grade` or `quadGrades(S.user.quad)`), so a
  broadened leader's home grade still reads at the top with the extra grade below it.

### Connect Setup: "unallocated students" scoping + sort fix (2026-07-10)

- **Bug**: a quad login's Total/Connected/Pending stat tiles and "Students not Connected"
  dropdown were inflated by students outside their own quad bracket — e.g. a Girls Yr 7–9
  quad login also saw Girls Yr 10–12 students counted there. Root cause: both are computed
  from `students`, which Connect Setup fetches with `?crossGrade=1` so the leader cards and
  Add Students picker can surface other-grade/other-bracket same-gender students to connect
  (intentional — see the "Add Students picker" entries above) — but that widened list was
  being reused, unfiltered, for the aggregate counts too.
- **Fix**: `renderConnectView()` now derives `connectable` through an `inOwnScope` filter
  (`s.quad === u.quad` for quad logins, `s.grade === u.grade` for grade logins, unfiltered for
  director/admin) before computing Total/Connected/Pending and the unallocated list.
  `students`/`_aS.students` itself stays unfiltered, so the leader cards and the Add Students
  picker still show/allow cross-grade connections exactly as before — only the two aggregate
  displays were narrowed. Verified in-browser (a quad login's totals dropped to match its own
  bracket; a leader was still connectable to an out-of-bracket same-gender student via the
  picker, and that connection didn't move the quad's own counts).
- **Also**: the "Students not Connected" list now sorts grade-ascending first, then
  alphabetically within each grade (`unallocated.sort(...)` in the same function) — relevant
  for quad/director/admin logins whose list spans multiple grades; a no-op for grade logins.

### Generalisation phases 1–5, 8 — "Connection Made Simple" → "Youth Connection" (2026-07-10)

A separate Claude session ("Generalisation of the app" project, sibling docs
at `../Generalisation of the app/`) is making this app deployable by **any**
youth ministry, not just YS Brisbane, via per-deployment configuration. This
session owned phases 1–5 and 8 of the design (`03-generalisation-design.md`);
phases 6–7 (structure/gender config, the new `leader` role) are a separate
Opus session — see `11-handoff-to-opus.md` for what it needs to know. Work
happened on branch `generalisation-phase-1` (rollback tag `pre-generalisation`
on `master`); **the YS Brisbane invariant held throughout**: with
`ministry_config = '{}'` (the default), every screen/import/export behaves
identically to before this work, verified after every phase.

- **Config storage**: one `ministry_config jsonb` column on `app_settings`
  (migration `018`), `MinistryConfigSchema` + `MINISTRY_CONFIG_DEFAULTS` in
  `src/core/ministry-config.ts` — the single source of truth every repo and
  the SPA read from. `PATCH /settings` deep-merges a partial `ministryConfig`
  patch via `mergeMinistryConfig`; a submitted `logoSvg` is sanitised
  (`sanitiseLogoSvg`, a denylist — not a real HTML parser). **Fixed a
  pre-existing bug while here**: `settings.service.ts.update()` now calls
  `invalidateOverviewCache()`/`invalidateTrendsCache()`/`invalidateLgStatsCache()`
  on every write — previously a settings change (even `termGapDays`) served
  stale stats for up to 60s with no invalidation hook at all.
- **Youth Ministry Setup wizard** (Admin → Settings → "Open Setup"): a
  4-preset picker (large-graded-au / two-bracket / small-flat / micro) that
  PATCHes the full merged `ministryConfig` + preset-scaled
  `serviceMinAttendance` in one call. **Gotcha fixed during implementation**:
  switching presets must always merge onto a clean `MINISTRY_CONFIG_DEFAULTS`
  baseline, never onto whatever the previous preset left in place — otherwise
  picking "large-graded-au" after "small-flat" wouldn't actually revert
  `modules.connectionAudit`/`roles.model`/etc. Steps 1–5 (branding/
  terminology/structure/roles/modules fine-tuning UI, beyond the preset
  picker) are stubbed (`/* SETUP-STEP-STUB */` in `renderMinistrySetup()`) —
  filled in by later work.
- **Theming**: the CA module's `--ca-*` CSS vars now re-point at the main
  `--accent`/`--navy`/etc. tokens (previously duplicated by value); the
  funnel/ladder colour ramps (previously 5 hardcoded hex arrays, two places)
  now generate from `branding.accent` via HSL lightness steps
  (`accentRamp`/`accentRampPairs`); the Executive Brief deck's inline CSS
  template interpolates `branding.accent`/`navy` and finally reads the
  long-dormant `ministryName` hook from the right (nested) path. Status/quad
  colours are deliberately NOT configurable (categorical, not brand).
  `applyTheme()`/`L()` (label lookup) live near the top of `index.html`'s
  main script, right after the `S` state object; a `THEME_CACHE_KEY`
  localStorage blob lets the login screen theme itself synchronously before
  `/settings` even resolves. **`GET /settings` is now fetched unconditionally
  at boot** (`boot()`), not just post-login as before — it's a public route,
  so the login screen genuinely can be themed pre-auth now, which it
  previously wasn't despite being able to.
- **`GET /manifest.json`** is now a dynamic route (`manifest.controller.ts`)
  templating name/short_name/theme_color from settings — the static
  `public/manifest.json` was **deleted** (Express serves static files before
  the route table, so it would otherwise always shadow the dynamic route).
  `brandMark()` renders a sanitised custom `logoSvg` when set.
  `install.html` derives its domain from `location.host` instead of a
  hardcoded production URL.
- **Label sweep**: `L(key)` (backed by `ministryConfig.labels`) replaced a
  first pass of "Lifegroup"/"Lifegroups" literals across Home, Trends,
  Health, Student Search, Connect Setup's xlsx export, and the CA module's
  tab bar + Lifegroup Health heading. **Deliberately not touched**: "Friday"
  (tied to `structure.serviceDayOfWeek`, which is functional — it also drives
  `_fridayLabel()`'s date math and week bucketing — and is phase 6/Opus
  scope, not just a label), "Student Team"/"Youth" labels beyond what's
  listed above, and the rest of the CA module's copy. `lgDisplayName()` now
  reads `labels.groupNameStrip` (prefix list) and `labels.smallGroup`
  (suffix) instead of the hardcoded `"Brisbane - YS - "` / `"Lifegroup"`.
- **Module toggles** (`ministryConfig.modules.*`): Connection Audit
  (`connectionAudit`, default `true`) — nav items gone, `ca-*` routes bounce
  home, and `ConnectionAuditService`'s 6 remaining methods (down from 7 —
  **the orphaned `POST /audits/finalize-live` route, controller method,
  service method, and its only caller `buildLiveLifegroupStats` helper were
  deleted** — confirmed zero SPA callers first) throw a new 404-shaped
  `ModuleDisabledError` via `requireCaModule(settings)` when off. The New
  Year Refresh wizard's steps 2/6 (audit backup/restore) render as "skipped"
  and count as satisfied for gating when CA is off, so step 3 (Full Reset)
  doesn't permanently block waiting on an audit export that'll never happen.
  Push notifications (`pushNotifications`, default `false` — matches
  today's hidden state) replaces all 5 `PUSH-HIDDEN` comment sites with a
  real config check (header bell + badge, `navItems()` × 4 roles, the
  notifications route, `doLogin()`'s permission request). Lifegroups
  (`lifegroups`, default `true`) hides the Trends tab, Home's "Lifegroups by
  Quad" section, and quad's per-grade lifegroup dropdown — display-only, the
  underlying at-risk/aggregate math already tolerates zero lifegroup data.
  `exportGuides` (`'elvanto'` default / `'hidden'`) gates both Elvanto
  walkthrough buttons.
- **Import atomicity** (the top-priority item, independent of
  generalisation): both importers' delete+repopulate phases now run inside
  one Postgres transaction (`sql.begin()`) when `PERSISTENCE=supabase` — a
  crash/kill between the truncate and the repopulate previously left the
  tables **truncated-but-empty** (a documented data-loss gap). New
  `src/repositories/supabase/with-transaction.ts`'s `bindImportRepos(tx)`
  rebuilds the 8 Supabase repos an import touches, bound to the
  transaction-scoped client instead of the shared module-level one; in-memory/
  JSON mode is unaffected (`sql: null`, no transaction primitive needed).
  Verified with a fake transactional `sql.begin` that snapshots/restores
  in-memory repos around a simulated mid-write throw
  (`import-atomicity.test.ts`) — a real kill-mid-import run against a
  scratch Supabase project is still the recommended manual check before this
  ships to production, since no fully-in-memory test can prove a real
  Postgres `ROLLBACK`.
- **Import report**: `ImportResult`/`GroupImportResult` gain a `report` field
  (`skippedRows` with a readable per-field reason, `nameCollisions` for two
  rows in the same upload sharing a name key) — no more silent `continue` on
  a bad row. The Import screen shows a "View import report" button when
  nonzero, reading from a module-level `_lastImportReport` var rather than
  inlining JSON into an `onclick` attribute (same apostrophe-escaping
  concern as `_smsHref()` elsewhere in this file).
- **Import dialect config** (`ministryConfig.import.*`): `dateOrder`
  (`'DMY'` default) reinterprets an ambiguous slash-separated date, but any
  date component `>12` auto-resolves to "day" regardless of the setting.
  Grade text (`"Year 7"`, `"Grade 9"`, `"7th"`) is now preprocessed into a
  bare integer before the existing 7–12 range check (range itself stays
  hardcoded — phase 6/Opus owns `structure.gradeMin/gradeMax`). `leaderTag`
  (`'leader'` default) makes the group importer's `"(leader)"` name-tag
  regex configurable. **Not done** (flagged, not silently skipped):
  client-side header-synonym matching and the long-format
  (Planning-Center-style) CSV pivot — both need real fixture data from a
  non-Elvanto export to implement safely.
- **Packaging**: `package.json` renamed `connection-made-simple` →
  `youth-connection` (code-side only — GitHub/Vercel dashboard renames are a
  manual owner step, not attempted). New `APP_ORIGIN` env var
  (`src/config/env.ts`) — production CORS falls back to it before the
  hardcoded YS Brisbane URL, so a new deployment sets one env var instead of
  editing code; the existing deployment needs no env changes. New
  `README.md` + `docs/DEPLOYING.md` covering the full deploy path incl. the
  statement_timeout and session-mode-pooler gotchas already documented
  elsewhere in this file.
- **SW cache**: bumped once per phase that touched `public/index.html`/
  `sw.js` (`cms-v22` at the start of this work → `cms-v27` by the end);
  `API_RE` gained `manifest\.json`.
- **Test suite**: 190+ → 237, all additive (no existing test was modified to
  make it pass, per the YS Brisbane invariant) — `ministry-config.test.ts`,
  `settings.service.test.ts`, `manifest.controller.test.ts`,
  `import-atomicity.test.ts` are new; `connection-audit.service.test.ts` lost
  3 `finalizeFromLive` tests and gained 2 module-toggle tests (net −1);
  `import.service.test.ts` gained report + dialect coverage.

### Generalisation phases 6–7 — structure config + the `leader` role (2026-07-11)

The Opus session that owned design doc §8 phases 6 (structure config) and 7 (the
new `leader` role). Built on the phase 1–5/8 `ministryConfig` foundation; the **YS
Brisbane invariant held throughout** — all-defaults (`ministry_config = '{}'`) is
byte-identical to before, and the full prior test suite (237) passes unmodified.
237 → **281 tests** (all additive). Branch `generalisation-phase-1`; migrations
`019`/`020` are additive (`add column if not exists`), so the `pre-generalisation`
rollback recipe still holds.

- **Multi-grade grade accounts (§5.1a, phase 6a).** A `grade` login can now span
  **one or more** grades. `User`/`Actor` gained `grades: Grade[]` + an explicit
  `gender` field **alongside** the legacy single `grade` (NOT replacing it — the
  existing `access-control.test.ts` builds actors with `grade` and old signed
  tokens carry only `grade`, so both must keep working). `access-control.actorGrades()`
  returns `grades ?? [grade]`; every `actor.grade` scoping read (`canAccessGrade`
  grade case, `leader.service`, `connection.service`, `lifegroup-stats`,
  `actor-key` — which MUST key on the full set or two multi-grade accounts collide
  their scoped caches) uses it. `deriveActorGender` prefers the explicit gender,
  falling back to the `grade7g`/`grade7b` username convention for untouched
  single-grade accounts. Account form: grade `<select>` → grade checkboxes
  (`ugcb`) + a gender-scope select. `account.service` stores `grade = grades.length===1 ? grades[0] : null`.
- **Structure config threading (§5.1/§5.2, phase 6b).** `access-control`'s
  `canAccessGrade`/`genderScopeOf`/`canAccessGender`/`canAccessStudent` gained an
  **optional** `StructureScope` param (`{cohortModel, genderPolicy}`) — undefined =
  today's `grades-quads`+`strict`, so existing tests/callers are unchanged.
  **⚠ Superseded 2026-07-12 — see "Bug 8 follow-up" below.** This paragraph
  originally had cohortModel `'none'` short-circuit BOTH grade AND gender
  scoping to visible for everyone (the design's "known trap"). That's no
  longer true: a Simple ministry's grade/quad accounts are now scoped to
  their assigned grades/gender exactly like a Complex ministry's. Left here
  for history; don't rely on the old behavior.
  `genderPolicy` `soft`/`off` drops gender scoping (still true, independent
  of cohortModel). Services pass
  `settings.ministryConfig.structure`; `overview` + `student` gained an **optional**
  `settingsRepo` (defaults when absent, so their existing test constructors are
  unmodified). Under `'none'`, `overview`/`trends`/`lifegroup-stats` return empty
  `byQuad`/`byGrade` (whole-ministry totals still show — nothing excluded; the SPA
  self-hides the empty sections + `_cohorted()` guards the student-derived
  "Connection by Grade").
- **Grade range** is `gradeRange(structure)` (`src/core/ministry-config.ts`),
  replacing every literal `[7..12]` iteration in the aggregate builders and the
  SPA (`_gradeList()`); the import `ServiceRowSchema` is now a factory bound to
  `gradeMin`/`gradeMax`, so an out-of-range grade is *reported*, not silently
  nulled.
- **serviceDayOfWeek** generalises `terms.ts`'s `saturdayOf(iso, serviceDayOfWeek=5)`
  to "week ends the day after the service day" (Friday default = the old Sat–Fri
  buckets, byte-identical). Threaded through `aggregates.ts`, `import.service.ts`
  (its own `weekStartOf` now delegates to `saturdayOf` so the anchor can't drift),
  `trends`, `lifegroup-stats`. SPA: `_fridayLabel`, the follow-up "Not Seen Last
  {day}" heading, the Trends tab, and the settings help text read `_serviceDayName()`.
  `year-aggregates.ts` (Connection Audit only) is deliberately left Friday-anchored
  — CA week math is out of the live-app scope. Tested in `service-day.test.ts`
  (a Wednesday-service ministry's term boundaries).
- **The `leader` role (§5.2, phase 7).** A junior leader: read-only
  (`student:read`+sensitive, `atrisk:read`, `leader:read`; **no** `connection:write`,
  `leader:write`, `overview:read`, import, admin), bound to one `Leader` record via
  `Actor.leaderId`/`User.leaderId`, seeing **only that leader's connected students**.
  Enforced server-side in every reachable read path: `student.service`
  list/get/search, `atrisk.service` (both gained an optional `connRepo`),
  `connection.service` (`listAll` own-only; `listByLeader`/`listByStudent` guarded
  by `assertLeaderSelf`/a connection check), `followup.leaderFollowup` (forces the
  actor's own `leaderId`). `overview` is simply not permitted (403). SPA: a slim
  `navItems` (Home / My Connections / Health / Birthdays), a lite `renderLeaderHome`
  (own follow-up, no overview fetch), `getMyLeaderId()` locks a leader login to its
  bound record, `_roleLabel()` drives config-aware role badges + the account-form
  role dropdown (flat model → Youth Pastor / Senior Leader / Junior Leader) + a
  leader-record picker; `render()` bounces a leader off any other page. Youth
  pastor / senior leader are pure label mappings onto admin / director.
- **Youth Ministry Setup wizard**: the Structure + Roles fine-tuning step (was a
  `SETUP-STEP-STUB`) is now real — cohortModel / grade word / grade range / gender
  policy / service day / role model / role labels, with an **orphaned-accounts
  warning** when switching cohortModel to `'none'` with grade/quad accounts present
  (never deletes — just flags). Branding/terminology/module editors remain phase
  2/3 stubs. **Grade range and the orphan warning were reworked 2026-07-12 —
  see "Bug 8 follow-up" below** (grade range is now an "Include Grade 6"
  toggle, not raw min/max fields; the warning now points at "Apply account
  layout" instead of manual Accounts edits).
- **Deliberate choices / deviations** (also in `../Generalisation of the app/12-handoff-final.md`):
  the seed (`src/seed.ts`) stays graded — it IS the YS Brisbane reference; a flat
  deployment uses the small-flat preset + manual account creation (design §7.1).
  Push `getUsersForTarget` is left graded-only — correctly **inert** under flat (no
  grade/quad accounts exist to target, and push defaults off). Manual student
  create/update (`student.service`) keeps a 7–12 bound (import is the config-aware
  path; manual add is admin-only and rare). `leader.service`'s grade/quad-scoped
  leader *management* stays strict-gendered (only reachable by grade/quad logins,
  which only exist under the graded model). Follow-up's leaderId override
  silently self-scopes a `leader` (returns their own list, never 403) — secure by
  construction.
- **SW cache**: `cms-v28` → **`cms-v31`** across phases 6a/6b/7. No new top-level
  API route was added, so `API_RE` is unchanged.

### Generalisation went LIVE + first-deploy incidents + Setup editors (2026-07-11)

The whole generalisation branch (phases 1–8, not just 6–7) was merged to `master`
and deployed to production (first time any of it went live — prod was
pre-generalisation `cms-v22`, DB at migration 017). Prod Supabase
(`ltcblcudlzlzfcyzlhpc`) migrated 017 → **020** (additive `add column if not
exists`: 018 ministry_config, 019 users.grades/gender, 020 users.leader_id);
existing data untouched (20 users / 677 students / 60 connections),
`ministry_config = '{}'` so behaviour is byte-identical. App name is now **"Youth
Connection"** (branding default). Two incidents surfaced on first real use, both
fixed:

- **`/manifest.json` served the SPA HTML** (broke the PWA manifest). Phase 8
  deleted static `public/manifest.json` for a dynamic Express route but didn't add
  it to **`vercel.json`'s `routes[]`** (which runs before Express). Fix: route
  `^/manifest\.json` → `/api/index.ts`. **Lesson: a new top-level route served by
  the function on Vercel must be added to `vercel.json` routes[], not just the
  Express router** (and to `sw.js` `API_RE`).
- **jsonb double-encoding → full app lockout.** Saving Setup stored
  `ministry_config` as a jsonb *string*; `getSettings()` (run on ~every request)
  threw in `MinistryConfigSchema.parse` → every `/settings` 500'd → whole SPA +
  Admin unreachable, unfixable in-app (recovered via `update app_settings set
  ministry_config='{}'::jsonb`). Root cause: `` `${JSON.stringify(cfg)}::jsonb` `` —
  postgres.js sees the `::jsonb` cast, types the param jsonb, and re-`JSON.stringify`s
  the already-stringified string. **Fix: write jsonb via `sql.json(value)`, never
  `JSON.stringify(x)::jsonb`** (fixed `supabase.settings.ts` + `supabase.users.ts`
  grades — same latent bug, never yet triggered on prod; `connection-audit.ts`
  already did it right). Also made the READ resilient (`parseMinistryConfig`:
  unwrap a stringified blob, fall back to defaults instead of throwing) so a bad
  config can't brick the app again. Tests: `ministry-config-encoding.test.ts`.

**Setup wizard — Branding / Terminology / Modules editors + deploy hand-off (built
2026-07-11).** The wizard's `renderMinistrySetup()` (public/index.html) now has
fully-editable **Branding** (`branding.*` incl. colour pickers + logo SVG),
**Terminology** (`labels.*`, incl. `groupNameStrip` as a per-line array via
`_setupSetList`), and **Modules** (`modules.*` toggles + `exportGuides`) cards,
alongside the existing Structure/Roles. No backend change — all flow through
`saveMinistrySetup()` → `PATCH /settings`. A final **"Deploy this setup to another
church"** card synthesises a tailored Supabase+Vercel deployment guide from the
current config (`_deployGuideText`), copyable/downloadable (`copyDeployGuide` /
`downloadDeployGuide`). Still stubbed: none of Setup — Branding/Terminology/Modules
were the last stubs. SW `cms-v31` → **`cms-v32`**. (Handoff brief that scoped this:
`SETUP-EDITORS-HANDOFF.md` at repo root.)

### Rename completed: "Connection Made Simple" → "Youth Connection" → "YS Connection" (2026-07-11)

Phase 8 (above) deliberately left the GitHub repo and Vercel project names untouched
("manual owner steps, not attempted"). Those manual steps are now done, in two
hops on the same day:

1. `citipointe-youth/connection-made-simple` → `citipointe-youth/youth-connection`
   (GitHub repo rename, `gh repo rename`; GitHub auto-redirects the old URL).
2. `citipointe-youth/youth-connection` → `citipointe-youth/ys-connection` — the
   owner decided the generic "Youth Connection" name should instead be
   "YS Connection" (matches `ministryConfig.branding.ministryName` default,
   "Youth Society Brisbane"). Same GitHub rename mechanism, plus the Vercel
   project was renamed via the dashboard (`connection-made-simple` → `ys-connection`
   directly, skipping the intermediate name) — production URL is now
   `https://ys-connection.vercel.app`. `APP_ORIGIN` was updated in Vercel's
   production env vars to match, and `vercel link` was re-run locally to refresh
   `.vercel/project.json` (project ID unchanged: `prj_jL3k8C9zHYw3lEbCFPNnvEct2DUX`).

Code/doc changes that went with it: `package.json` name → `ys-connection`;
`MINISTRY_CONFIG_DEFAULTS.branding.appName` (and the SPA's mirrored
`MINISTRY_CONFIG_DEFAULTS_CLIENT`) default → **"YS Connection"** (was "Youth
Connection" — this changes the default seen by anyone who hasn't set their own
branding in Setup, i.e. still-current YS Brisbane); `<title>`/install-page/push
fallback strings in `public/index.html` / `install.html` / `sw.js` updated to
match; SW cache bumped `cms-v32` → **`ysc-v33`** (also dropped the `cms` —
"Connection Made Simple" — abbreviation from the cache-name prefix); `env.ts`'s
`PROD_DEFAULT_ORIGIN` fallback and `.env.example`'s CORS comment updated to
`ys-connection.vercel.app`. `ministry-config.test.ts` / `manifest.controller.test.ts`
updated to assert the new default. Local git remote repointed to
`github.com/citipointe-youth/ys-connection.git`.

**Not renamed (deliberately)**: historical/dated CLAUDE.md sections above this
one, `CHANGELOG.txt`, and old `docs/superpowers/plans|specs/*` — they're a
point-in-time record of what the app was called when that work happened, not
live documentation. If a ministry other than YS Brisbane deploys their own copy
via Setup, "YS Connection" is just the seed default — it's fully overridable
(`branding.appName`) the same as before.

### Roles fix: dropped the "Senior/Junior Leader" relabeling; roles are now on/off toggles, not renames (2026-07-11)

Phase 7 (above) shipped `roles.model` ('graded'/'flat') + `roles.labels`
(free-text per-role names), defaulting the flat preset to Youth Pastor/Senior
Leader/Junior Leader — a misreading of what was actually wanted. **Senior/
junior was meant to describe a GRADE RANGE split (senior = Yr 10-12, junior =
Yr 7-9), not a pair of roles with different permissions.** That's already
covered by the existing multi-grade `grade` account feature (§5.1a, phase
6a) — assign one broad account grades 10-12 for a "senior" login, another
7-9 for "junior"; no role change needed for that at all.

- **`roles.model`/`roles.labels` removed**, replaced by `roles.enabled: {
  director, grade, quad, leader }` (`src/core/ministry-config.ts`). Role
  names are fixed everywhere — Admin, Director, Grade, Quad, Leader — no
  per-deployment renaming. Admin always exists and isn't toggleable;
  Director/Grade/Quad default **on** (today's YS Brisbane behaviour under
  `{}` config); Leader defaults **off** for every preset, including
  small-flat/micro (previously it was silently on under 'graded' and
  relabeled "Junior Leader" under 'flat' — neither was actually wanted by
  default). Grade is toggleable too (not fixed-on like Admin) so a ministry
  can run on Leader-only logins instead of Grade logins if it wants.
- **`small-flat`/`micro` presets** now set `roles.enabled: { director: false,
  quad: false }` instead of relabeling — a simple ministry manages everything
  through Admin + (multi-grade) Grade accounts by default, with
  Director/Grade/Quad/Leader all available as opt-in toggles in Setup →
  Roles if a ministry wants a different mix.
- **SPA**: `_roleLabel()` returns the fixed name directly (no more reading
  `ministryConfig.roles.labels`); `_accRoleOptions()` (the account-creation
  role `<select>`) now reads `roles.enabled.{director,grade,quad,leader}`
  instead of `roles.model === 'flat'` — admin is unconditional, the other
  four are only offered when enabled (an already-assigned-but-since-disabled
  role stays selectable for that one account, same guard as before). Setup's
  Roles card shows Admin as a fixed checked-and-disabled row (so its tooltip
  is reachable even though it's not a real toggle) above four checkboxes
  (Director/Grade/Quad/Leader), replacing the old "Role model" dropdown +
  free-text label inputs.
- **UI-only, same as the field it replaced**: nothing server-side gates
  account creation by `roles.enabled` (mirrors how `roles.model` was never
  enforced server-side either) — `account.service.ts`'s role validation is
  unchanged. No live accounts were affected: prod `ministry_config` is still
  `{}`, so Director/Quad stayed on and Leader stayed off throughout this
  change.
- Tests: `ministry-config.test.ts` updated (`roles.enabled.*` assertions
  replace the old `roles.model`/`roles.labels` ones).
- **SW cache**: `ysc-v34` → `ysc-v35` → `ysc-v36` → **`ysc-v37`** (public/
  index.html changed three times: the initial toggle rework, adding the
  Grade toggle + the fixed Admin row, then the syntax-error fix below.
- **Incident: white screen in production** — the Admin row's `helpTip(...)`
  call used a single-quoted JS string whose text contained an apostrophe
  ("...and it **can't** be turned off."), which closed the string early and
  left a trailing `t be turned off.')` as invalid tokens — a hard
  `SyntaxError` in the app's one inline `<script>` block, so **nothing** ran
  (not just that row — the whole SPA). The app already has this exact
  pattern flagged: earlier `helpTip(...)` calls whose text contains an
  apostrophe use **double quotes** instead (e.g. the Health tab's "hasn't
  been to Youth..." tip) — this one didn't follow it. **Lesson**: any
  contraction (can't/won't/doesn't/isn't/hasn't/...) inside a single-quoted
  JS string literal in this file is a syntax error, not just a stray
  character — grep `helpTip\('[^']*'(t|s|re|ve|ll|d)\b` (or similar) for
  apostrophes before shipping new inline help text, and verified here with
  `node --check` on the extracted `<script>` body (533–6842), the same
  syntax-check convention documented for Project 1's single-file apps.

### Bug/polish punch list — password-change token bug, role-disable cascade, Youth Setup reorg (2026-07-11)

- **Fixed: blank page after first-login "Set Password & Continue"** (previously
  needed refresh + sign out + sign back in). Root cause: `mustChangePassword`
  is baked into the signed session token at login (`toActor()`/`signSession()`
  in `auth.service.ts`) and `resolveToken()` trusts the embedded actor with no
  DB re-check — so `changeOwnPassword()` clearing the DB flag left the
  client's existing token still enforcing `MUST_CHANGE_PASSWORD` (403) on
  every route except the 3 allowlisted ones for the rest of its 12h TTL. Only
  a fresh login (new token) worked around it. Fix: new `AuthService.
  issueTokenFor(userId)` mints a token from current DB state;
  `POST /accounts/me/password` (`account.controller.ts`) now returns
  `{ ok, token }` and both frontend call sites (`submitMustChangePassword`,
  the Connect Setup "Change Your Password" modal) call `API.setToken()` with
  it before re-rendering.
- **Fixed: Branding logo-mode buttons ("Default mark"/"Paste SVG"/"Upload
  image") didn't work.** `logoMode` was derived purely from whether
  `branding.logoSvg`/`logoImage` already had content — so picking "Paste SVG"
  before typing anything left both still `null`, and the next re-render
  recomputed `logoMode` back to `'default'`, snapping the picker (and the
  textarea/file input it gates) back before you could use it. Fix: a
  transient `_logoModeOverride` var, set the instant a mode button is
  clicked, used as the fallback when neither field has content yet; reset
  whenever the setup draft is freshly loaded (`_ensureSetupDraft`).
- **New: disabling a role in Youth Setup (Director/Grade/Quad/Leader) now
  deactivates its accounts and hides its Accounts-screen section.**
  `settings.service.ts`'s `update()` diffs `roles.enabled` before vs. after
  the merge; any role that flips `true→false` bulk-deactivates every
  currently-active `User` of that role (`IUserRepository.findByRole`).
  Re-enabling a role later does **not** auto-reactivate — deliberate, so an
  account an admin separately deactivated for an unrelated reason isn't
  silently un-deactivated by an unrelated toggle; reactivation stays manual
  via the existing per-account lock/unlock. The Accounts screen
  (`renderAdminView`) now also skips a role's whole group when
  `roles.enabled.<role> === false`, not just when it happens to have zero
  accounts.
- **My Students: added the same "Custom Message Template" editor Home's
  Follow Up section has**, right below the leader picker once a leader is
  selected — so a leader doesn't have to go back to Home to edit it. Both
  spots now share `_smsTemplateBoxHtml()`/`_saveSmsTemplate()` (was
  Home-only, named `_saveFollowupSmsTemplate`).
- **Youth Setup reorg**: "Save Youth Setup" moved from the top of the tab to
  the bottom, now behind a confirm modal (`confirmSaveMinistrySetup()` — it's
  live config for every user, not a per-device preference); the preset-picker
  card gained a "Pre-set Configurations" heading; the standalone Attendance
  card is gone — Min Attendance/Term Gap moved to the bottom of Structure &
  Roles with `helpTip()` tooltips instead of inline paragraphs, and the
  "students are flagged as..." paragraph (redundant with the Health tab's own
  tooltip) was dropped; Terminology's disabled/read-only "Small group
  (plural)" row was removed (the plural has been auto-derived since the
  2026-07-11 entry above — this just stopped rendering the leftover dead
  field); the standalone Import card was merged into Modules (now "Modules &
  Import"); Branding's "Reset to defaults" button moved into the card's own
  header row, next to the title, via a new optional `headerActionHtml` param
  on `_setupCard()`.
- **Dropdown `<select>` styling**: `.fs` previously had no custom arrow at
  all (relied on each browser's inconsistent native one, with no reserved
  padding) — added a fixed, centered SVG chevron + right padding so the
  arrow position is consistent and doesn't crowd the selected text.
- **Lifegroups module gating gaps closed**: the Home hero card's two
  "Lifegroups" summary-table rows (this-term and prev-term) and the Import
  screen's "Service or Group" copy/tooltip were unconditional even when
  `modules.lifegroups` is off — everywhere else on Home already respected it.
  New shared `_lifegroupsOn()` helper (mirrors `_exportGuidesOn()`).
- **Trends export** (`exportTrendsCSV`, quad/director/admin only): now builds
  an `.xlsx` via the same vendored SheetJS used elsewhere (was a fixed-name
  `trends.csv` text blob) with a dated filename (`trends-YYYY-MM-DD.xlsx`);
  the Grp/lifegroup columns are now also skipped when `modules.lifegroups`
  is off, same gating as above.
- **SW cache**: `ysc-v39` → **`ysc-v40`**.
- New/updated tests: `auth.service.test.ts` (`issueTokenFor`),
  `settings.service.test.ts` (role-disable deactivation cascade, 5 new cases).

### Admin bug/improvement batch (2026-07-12)

An admin-reported punch list, worked through in three passes. Bugs 1-7 below are
independent small fixes; bug 8 (cohort model / account layout) grew into the
biggest change and is split into its own subsections.

**Bugs 1-7:**
- **Grade-change auto-rename now also syncs display name** (was: username only).
  `suggestEmail()` (public/index.html) tracks `_acctAutoEmail`/`_acctAutoName` —
  a field is only overwritten while its current value still equals what this
  logic last generated (or is empty), so a grade/gender edit keeps a
  still-default name in sync but never clobbers a name the admin already
  customised (bug 3's ask). Scoped to `role==='grade'` only.
- **Seed grade accounts get an explicit `gender`** — see the Seed demo accounts
  section above (migrations `0003`/`0004`).
- **Inactive accounts sort to the bottom of their role group** in Accounts
  (`renderAdminView`) — a stable sort layered after the existing grade-number/
  quad-label ordering.
- **Grade/quad account rows get a light girls/boys background tint**
  (`.li.acct-girls`/`.acct-boys`) via the existing `_loginGender()` helper.
- **Allocation re-import gained an opt-in "auto-create unmatched leaders"
  checkbox** (Admin → Data tab, default OFF). `POST /connections/allocations/
  import` takes `autoCreateLeaders: true`; `deriveLeadersToCreate()`
  (`connection-allocations.ts`) derives grade(s)/gender from whichever
  already-matched students in the file are paired with that unmatched leader
  name (null gender if they disagree), `connection.service.ts` creates the
  `Leader` rows via `leaderRepo.saveMany` before planning the sync so those
  rows resolve as matched instead of landing in `unmatchedLeaders`. Report
  gained `leadersCreated`.
- **Youth Setup terminology fields got tooltips** explaining where each one
  actually shows up in the app (see the terminology-wiring entry just below —
  two of these tooltips went stale within the same day and got corrected).

**Bug 8 — Cohort model / Simple ministry, in the order it actually shipped:**

1. **"Apply account layout"** (`src/services/cohort-account-layout.ts`, new
   file) — a separate, explicit, typed-confirm action in Youth Setup
   (`POST /accounts/cohort-layout/preview` then `/apply`) that reconciles
   Accounts with the ministry's cohort model, decoupled from Save. `Complex`
   target = one grade account per grade + the 4 quads; `Simple` target = 6
   grade-bracket accounts (2 genders × 3 brackets), no quads.
   `planCohortAccountLayout` diffs by username (case-insensitive) against
   existing accounts — matches are left completely alone, unmatched active
   grade/quad accounts are **deactivated, never deleted**, missing targets are
   **created** with a random one-time password (`mustChangePassword: true`,
   shown once in the result modal). `account.service.ts` gained
   `planCohortLayout`/`applyCohortLayout`; needs `ISettingsRepository` now
   (`makeAccountService(users, settings)` — 2 args, was 1; 3 test files
   updated).
2. **Simple preset also disables Director** (was: Admin+Director+Grade;
   now Admin+Grade only) — `PRESET_CONFIGS.simple`/`PRESET_CONFIGS_CLIENT`
   set `roles.enabled.director: false`, reusing the existing generic
   role-disable-deactivates-accounts cascade in `settings.service.ts`.
3. **Cohort model dropdown relabelled Complex/Simple** (was "Grades + quads
   (graded)" / "No cohorting (flat)") — **UI label only**, the stored enum
   values (`'grades-quads'`/`'none'`) are unchanged.
4. **Real scoping bug found and fixed**: `cohortModel: 'none'` used to make
   `canAccessGrade`/`genderScopeOf` (`access-control.ts`) bypass ALL grade/
   gender access control for every login — the documented "known trap" ("under
   'none' nothing may be hidden by grade or gender"). This made a Simple
   ministry's own boys/girls-bracket accounts (from #1 above) purely cosmetic
   labels with **zero actual restriction** — a "Girls 7/8" login could see
   Boys 11/12 students too. Fixed: grade/quad accounts are now scoped by their
   assigned grades/gender identically under both cohort models. cohortModel
   now ONLY changes account layout (#1) and report-breakdown granularity
   (`overview`/`trends`/`lifegroup-stats` still hide `byQuad`/`byGrade` under
   `'none'` — that part is unchanged and is a reporting choice, not a security
   one). `visibility-matrix.test.ts` rewritten — 'none' now asserts the SAME
   visibility as 'grades-quads' throughout, not "everyone sees everyone."
   **If you're touching `canAccessGrade`/`genderScopeOf` again: do not
   reintroduce a `cohortModel === 'none'` bypass** — see the superseded-note
   left in the phase 6b entry above.
5. **"Include Grade 6" toggle** replaces the old Lowest/Highest grade number
   inputs in Structure & Roles — the top grade is always 12 in practice, so
   the only real question is whether the ministry also takes grade 6 straight
   from kids' church. `_setupSetGrade6()` sets `structure.gradeMin` to 6 or 7
   and forces `gradeMax` to 12 in one PATCH. `gradeBrackets()`
   (`cohort-account-layout.ts`) reworked to anchor brackets from the TOP down
   (`11-12`, `9-10`, ...) and fold any remainder into the LOWEST bracket
   instead of spawning a new one — grade 6 included → lowest bracket becomes
   `6-7-8`, not a separate 4th Simple account. Complex is unaffected by this
   change (still one account per grade in range, so grade 6 there just adds 2
   accounts: Grade 6 Girls/Boys).
6. **"Apply account layout" is always visible** (was: only shown while the
   draft's cohort model differed from the saved one), greyed out when Accounts
   already match. Enablement is computed **client-side**, via a mirror of the
   backend's plan logic (`_gradeBracketsClient`/`buildTargetAccountsClient`/
   `planCohortAccountLayoutClient` in public/index.html — keep in sync with
   `cohort-account-layout.ts` the way `MINISTRY_CONFIG_DEFAULTS_CLIENT` etc.
   already mirror their backend counterparts) against `_adminData.users` +
   the SAVED settings, so a Grade-6-toggle-only change (same cohort model)
   still surfaces the button, and there's no extra round-trip on every
   Youth Setup render. The button always targets the SAVED cohort/grade
   range, never the unsaved draft — save Youth Setup first if you just
   changed either.
7. **Changing the Cohort model dropdown directly now also auto-selects
   Director/Quad** the same way the preset buttons do (`_setupSetCohortModel()`
   — Complex turns both on, Simple turns both off), without resetting the
   rest of the draft the way `pickMinistryPreset()` does.
8. **Every Youth Setup tooltip rewritten** for plain language (no assumed
   knowledge of the app's internals — "login" not "actor"/"scope", no
   `cohortModel`/`genderPolicy` literal values in the copy) and trimmed for
   length, after an initial pass had gotten dense/jargon-heavy. Two
   Terminology tooltips (Service / Service night wording) had to be corrected
   twice the same day: once because the terminology-wiring work below made
   their "not really used yet" wording stale, and again for the plain-language
   pass.

**`labels.service`/`labels.serviceNight` terminology wiring**, done alongside
the above after discovering (while writing bug 7's tooltips) that both fields
were mostly decorative — `service` ("Youth") had exactly one real call site
(`L('service')`) and `serviceNight` ("Friday Nights") had zero. Both are now
threaded through Home, Trends, Health, Student Search, Connect Setup's export,
and the whole Connection Audit module (funnel labels, Data-tab slots/toasts,
the deck, the Elvanto export-guide instructions). Two module-scope `const`s had
to become functions since they were evaluated once at script-parse time, before
`S.settings`/`L()` had anything to read — **`STG`/`STG_SHORT` → `STG()`/
`STG_SHORT()`** (stage-name maps) and **`EXPORT_GUIDES` → `EXPORT_GUIDES()`**
(the Elvanto walkthrough content); every call site updated to call them.
Deliberately left un-wired: the Elvanto guide's literal Elvanto UI values that
aren't this app's own terminology (e.g. "Demographics: Youth" is an Elvanto
filter option name, not `labels.service`), and the two preset-picker
description strings in `MINISTRY_PRESETS_INFO` (still a frozen module-scope
array — same staleness risk as `STG` used to have, but low-traffic enough
(shown once, pre-customisation) that it wasn't worth converting too). A
follow-up pass also caught missed `labels.smallGroup`/`smallGroupPlural`/
`structure.gradeLabel` spots (the Lifegroups module toggle label, CA
lifegroup-health table headers, Data-tab group slot/toasts, a few CSV headers,
the Elvanto guide's "Lifegroup" category-name mentions) — grep for a bare
`'Lifegroup'`/`'Grade'` string literal before adding new UI copy; the
correct call is `L('smallGroup')`/`L('smallGroupPlural')`/`_gradeWord()`.

### Admin account preview (2026-07-12)

Admin → Accounts gets a **"Preview"** button on every **active `grade`/`quad`** account row
(not director/leader/admin). Clicking it drops the admin into a real, fully-functional session
as that account — same nav, same server-side RBAC scoping, real reads AND writes (the app has
no per-write attribution today and the admin explicitly wanted read+write parity, not a
read-only simulation) — with a persistent amber banner ("Previewing: *name*" + Exit Preview)
visible on every screen until they exit. Design rationale + rejected alternatives (a `?viewAs=`
query-param override; a pure client-side simulation mirroring the Youth Camp Platform's
same-user "at-camp preview") are in
`docs/superpowers/specs/2026-07-12-admin-account-preview-design.md`.

- **Backend**: `POST /accounts/users/:id/preview` (admin-only) → `AccountService.previewAccount`
  validates the target is active + grade/quad, then `AuthService.issueTokenFor(id,
  { mustChangePassword: false })` mints it a real session token. `issueTokenFor` gained an
  optional `actorOverrides` param for this (all existing call sites unaffected). The endpoint's
  JSON response ALSO forces `mustChangePassword:false` on the returned `user` object, not just
  the token — the frontend renders off `S.user.mustChangePassword` directly, separately from
  whatever's embedded in the token, so both had to be overridden or previewing a
  never-logged-in account would immediately show *that* account's forced-password screen.
  **⚠ Updated 2026-07-12 (independent review follow-up, same day)** — the minted token now uses
  a short 1h TTL (`PREVIEW_TOKEN_TTL_MS`), not the normal 12h; see "Independent review
  follow-up" below.
- **Frontend**: `enterPreview(id)`/`exitPreview()` (public/index.html) swap `API`'s token +
  `S.user`, `Cache.clear()`, and rebuild the persistent shell (`_initShell()`) — nav, role
  badge, and screen visibility all come for free since it's swapping in a real actor, not
  duplicating RBAC client-side. The admin's own session is stashed in a module-level
  `_previewStash` var, mirrored to `localStorage['yap_preview_stash']` so a page refresh
  mid-preview doesn't strand the admin — restored at the top of `boot()`. Both `exitPreview()`
  and `doLogout()` clear the stash.
  - **Gotcha this surfaced**: `boot()`'s `/auth/me` refresh (used to restore `S.user` after any
    page reload) reads the raw DB record, which doesn't know a preview session is in progress —
    without re-applying the `mustChangePassword:false` override there too, a page refresh
    mid-preview of an account with a genuinely-unset password would re-trigger its forced-
    password screen even though the initial preview response had already suppressed it.
- **Explicitly not built** (decided during brainstorming, matches "the app is already agnostic
  about who makes changes"): no write-blocking, no audit/logging of preview sessions.
- **Follow-up, same day**: the Preview button/banner now use a dedicated `eye` icon (was
  reusing `id`, the profile-view icon, which read ambiguously). A confirm modal
  (`confirmEnterPreview(id)` — looks the account up from `_adminData.users` rather than passing
  `displayName` through the `onclick` string, avoiding the apostrophe-escaping gotcha noted
  under Connect Setup's SMS templates above) now asks "Do you want to preview the *X* login?"
  before `enterPreview()` actually runs — the brainstorming decision above to skip a
  confirmation step was revisited and reversed.

### Admin account protection now locks the username, not the display name (2026-07-12)

Bug fix: `isProtectedAdmin()` (`account.service.ts`, mirrored client-side as `_isProtectedAdmin()`
in `public/index.html`) used to key off `displayName === 'Admin'` and lock *that* field — backwards,
since the display name is a cosmetic label and the username (`email` field) is the actual login
credential. Now keys off `email === 'admin'` (the seeded bootstrap username) — that account's
username is permanently locked, its display name is freely editable like any other account's.
Falls back to `displayName === 'Admin'` too (OR, not replace) so an account already renamed away
from username "admin" under the old rules doesn't silently lose protection — this matters because
`email` used to be the freely-editable field, so a real admin may already have changed it in
production before this fix shipped. Same swap applied in three places: `AccountService.update()`
(guard moved from `patch.displayName` to `patch.email`), `toggleStatus()`/`remove()` (guard
condition swapped to `isProtectedAdmin()`, error text now interpolates the account's current
`displayName` instead of hardcoding "Admin"), and the Edit Account modal (Username input now
`disabled` for the protected account instead of Display Name).

### Independent review follow-up: SVG-logo XSS closed, preview token TTL shortened, cohort-layout drift detection (2026-07-12)

An independent Six-Thinking-Hats review of the preceding few days' generalisation/Youth Setup/
account-preview work (user-requested, not a bug report) surfaced one live issue and two
lower-severity gaps. Fixed the same session, choosing the lightest fix that closes each gap now
rather than the heavier "proper" version of each — see the review's Green Hat for what was
deliberately not built.

- **Removed raw-SVG-paste branding entirely — this was a live XSS gap, not a theoretical one.**
  `sanitiseLogoSvg()`'s denylist regex (`\son\w+\s*=\s*(["']).*?\1`) required a QUOTED attribute
  value to strip an event handler — an unquoted payload like `<svg onload=alert(1)>` passed
  straight through untouched. `brandMark()` then rendered `branding.logoSvg` via raw `innerHTML`,
  and it renders on the **public, pre-auth login screen** (branding themes the login page before
  `/settings` even resolves — see "Theming" under Generalisation phases 1–5 above). Net effect:
  a careless or compromised admin pasting SVG from an untrusted source could persist an XSS
  hitting every visitor before they log in. Decided to drop the feature rather than harden the
  sanitiser (a real SVG sanitiser is more machinery than a rarely-used paste-in-code option
  earns; the raster upload-and-crop path already covers the real use case). `branding.logoSvg`
  is gone from `MinistryConfigSchema` entirely — Zod silently strips an unknown key on the next
  `mergeMinistryConfig`, so even a raw API PATCH can't resurrect it (verified live against a
  running server: PATCHing `{branding:{logoSvg:"..."}}}` round-trips with no `logoSvg` key at
  all). `sanitiseLogoSvg`/`DANGEROUS_SVG_RE` deleted from `ministry-config.ts`; Setup → Branding's
  Logo picker is now Default mark / Upload image only. SW cache `ysc-v40` → **`ysc-v41`**.
- **Admin account-preview tokens now expire in 1h, not the normal 12h**
  (`PREVIEW_TOKEN_TTL_MS`, `auth.service.ts`). A preview mints a real, fully-privileged session
  token for the target account that sits in the admin's browser `localStorage` *alongside* their
  own stashed token — shortening its life meaningfully bounds that extra exposure window without
  needing server-side token revocation (tokens stay stateless everywhere else in this app too).
  `issueTokenFor()` gained an optional third `ttlMs` param for this only; every other call site
  is unaffected and still defaults to 12h. `exitPreview()` itself needed no change — it was
  already a pure client-side token swap with no server round-trip, so it still works instantly
  even after the preview token has expired.
- **"Apply account layout" now flags (never auto-fixes) accounts that have drifted from what
  their username implies.** The plan only ever matched existing vs. target accounts by
  USERNAME — an account whose actual `grades`/`gender`/`quad`/`role` no longer matched what its
  username implies was silently treated as "already correct" and never resurfaced, even though
  the feature reads to an admin as a reconciliation tool. `planCohortAccountLayout()`
  (`cohort-account-layout.ts`) now also returns a `mismatched` list (id/username/displayName/
  reason) for username-matched accounts whose fields disagree with their target spec —
  informational only, per this feature's existing "never silently edit a matched account" rule.
  `ExistingAccountLite` gained optional `grades`/`gender`/`quad` fields, only compared when a
  caller actually supplies them (so existing unit tests that construct bare `{id,role,email,
  displayName,status}` objects are unaffected); `account.service.ts`'s two callers
  (`planCohortLayout`/`applyCohortLayout`) now pass them through from the real user record.
  Surfaced as a non-blocking warning in the "Apply account layout" preview modal
  (`_showCohortLayoutPreview`), listing each mismatched account and why. The client-side
  enablement mirror (`planCohortAccountLayoutClient`) is untouched — a mismatch doesn't change
  whether the button reads "already aligned", only what the preview modal shows once clicked.
- Tests: `ministry-config.test.ts`/`settings.service.test.ts` updated (assert a `logoSvg` patch
  is dropped, not sanitised — the old sanitiser-specific cases are gone with the feature);
  `auth.service.test.ts` gained `ttlMs` coverage; `account.controller.test.ts` asserts the
  preview endpoint passes `PREVIEW_TOKEN_TTL_MS`; `cohort-account-layout.test.ts` gained 6 cases
  for `mismatched` (role/grades/gender/quad drift, inactive accounts ignored, a clean match never
  flagged). 341 tests total (was 335), typecheck clean.

### Home "Birthdays this week" re-scoped off the leader identity (2026-07-13)

The Follow Up card's "Birthdays this week" list was sourced entirely from
`GET /connections/leader/:id/followup`'s `birthdays` field — which, like the rest of that
endpoint, is scoped to whichever leader identity the user self-identified as
(`getMyLeaderId()`), i.e. only THAT leader's own connected students. That's the right scope
for the "Not seen at Friday/Lifegroup" lists (the point of self-identifying), but wrong for
birthdays, which should reflect the login's own grade/quad, not one leader's connection
subset.

- `grade`/`quad` roles: Home now computes "birthdays this week" client-side from its own
  already role-scoped `/students` fetch (`_scopedWeeklyBirthdays()`, public/index.html) —
  restricted to "connectable" students (`_hasAttended`, attended this or previous term, same
  rule Home's connection counts use) — instead of `data.birthdays`. `_isBirthdayInWeek()` is a
  frontend port of `followup.service.ts`'s `isBirthdayInWeek` — **keep them in sync**.
- `admin`/`director` roles: the Birthdays-this-week card is suppressed entirely (not just
  scoped wider) — ministry-wide "this week" wasn't a useful view there per the bug report.
- Dedicated junior-`leader` role (a real individual leader's own login, not grade/quad staff)
  is **unchanged** — their own connected students already ARE their scope, so it still reads
  `data.birthdays` from the followup endpoint.
- The card is still gated behind picking a leader identity on Home (unchanged UX) — only the
  *source* of the birthdays list changed once shown, via a module-level `_homeBirthdaysCtx`
  (`undefined` = leader-scoped `data.birthdays`, `null` = suppress, array = grade/quad-scoped)
  set once per Home render and read by `renderHomeFollowup()`, which is itself re-invoked with
  no args from the "Not you?"/pick-a-leader `onclick` handlers.
- Backend `followup.service.ts` is untouched — `leaderFollowup`'s own `birthdays` field is
  still leader-scoped and still used for the `leader` role; grade/quad/admin/director just stop
  reading it.
- `public/sw.js` cache bumped `ysc-v41` → `ysc-v42` (SPA JS changed).

### Prayers feature + a real deployment incident: the custom domain does NOT auto-alias (2026-07-18)

Shipped a `Prayers` module (`feat/prayers` → `master`): per-student or "general" (no student)
prayer requests, admin/director CSV export/import, a New Year Refresh wizard step, a nav tab,
and a per-student summary on My Connections. New table `prayer_requests` (migrations
`0005`/`0006`; `student_id` nullable — general prayers have none), `PrayerService`/
`IPrayerRepository`/Supabase impl, `prayer:read`/`prayer:write` RBAC actions (student-resolved
scoping, same pattern as connections). SW cache `ysc-v42` → `ysc-v44`.

**Deployment incident + the real root cause (not a code bug).** Earlier the same day, pushing
the unrelated `3a7bbc6` login-form fix to `master` appeared to break production — every route
failed with a platform-level `EnvFileReadError` loading env vars, before app code even ran. A
session rolled back to the prior deployment via `vercel rollback` and it looked resolved. But
re-investigating to re-ship that fix surfaced the ACTUAL mechanism, confirmed by direct testing:

- **This project's custom production domain (`ys-connection.vercel.app`) does NOT
  automatically re-alias to the newest deployment** — not on `git push` to `master`, and not
  on a manual `vercel deploy --prod`. Both successfully create a new `Ready` deployment
  targeted at `production`, but the custom domain keeps pointing at whatever it was last
  EXPLICITLY aliased to (`vercel alias set <new-deployment-url> ys-connection.vercel.app`).
  Only the default `<project>-<team>.vercel.app` alias updates automatically. This is a
  project/domain configuration quirk (most Vercel projects DO auto-promote all production
  domains) — not something to "fix" in code, just something to always do as a manual step.
- **So what actually happened**: the login-form deploy went out, someone ran the manual
  alias step, and THAT promotion is what exposed users to the `EnvFileReadError` — a separate,
  apparently one-off Vercel platform runtime glitch (build succeeded/`Ready`; the code in
  `src/config/env.ts` only reads `process.env`, no file I/O, so nothing in this repo could throw
  that error). Rolling back re-aliased to the prior deployment, which "fixed" it. Redeploying
  the exact same commit later the same day (fresh build + fresh manual alias) worked fine — 200s
  on `/`, `/auth/me`, `/manifest.json`, `/settings` all healthy, confirming it was transient.
- **Practical takeaway for every future deploy to this project**: after `git push origin
  master` (or `vercel deploy --prod`), don't assume the push alone updates
  `ys-connection.vercel.app`. Verify with `vercel inspect ys-connection.vercel.app` (check the
  `id` matches your new deployment) and if not, run `vercel alias set <new-deployment-url>
  ys-connection.vercel.app` explicitly, then re-verify with a few `curl` health checks
  (`/`, `/auth/me` should 401 not 500, `/settings` should return real JSON) before trusting it.
- **Also learned**: `vercel inspect <deployment-id-or-url>` prints an "Aliases" section that
  lists domains the deployment is *eligible* to hold (production-target + rollback-candidate
  domains) — it does NOT reliably show which domain is *currently* live on it. Two different
  deployments can both list the same alias there. To find the deployment TRULY live behind a
  domain, `vercel inspect <the-domain-itself>` (not a `-xxxxx-` deployment URL) is authoritative.
- **Confirmed again the same day**: every subsequent push to `master` (the docs commit above,
  then the Prayers UI-polish commit below) each produced its own new deployment, and NEITHER
  auto-aliased `ys-connection.vercel.app` either — this is a standing characteristic of this
  project, not a one-off. `vercel alias set <new-deployment-url> ys-connection.vercel.app` is a
  required manual step after every single deploy to this project, full stop.

### Prayers UI polish (2026-07-18, same day as the feature shipped)

User-requested tweaks to the just-shipped Prayers screen and the leader-identity picker on
Home/My Students, deployed the same day:

- **Add Prayer FAB raised ~1cm**: `.pfab`'s `bottom` `76px` → `114px` so it sits clear of the
  bottom nav more comfortably.
- **Add/Edit Prayer modal's "For" field**: the "Not about a specific student — mark as general"
  sentence-styled link (and its "Change" counterpart) is gone, replaced by a small `Student` /
  `General` tab pair above the student search box. Only shown for a brand-new, not-yet-locked
  prayer (adding one from a student's own profile, or editing an existing prayer, still shows
  the locked chip/general label with no toggle — unchanged). `_prayerUsePicker()`/
  `_prayerUseGeneral()` now also swap the two tab buttons' active styling in addition to
  toggling which body (search box vs. general label) is visible.
- **Leader-identity "Not you?" control made an obvious button** on both screens it appears —
  Home's Follow Up card (pre-existing, was `btn-ghost btn-sm` at a tiny `11px`, read as a faint
  text link) and a new equivalent added to My Students (didn't exist before; sits next to the "I
  am…" label once a leader is chosen, doing the same `setMyLeaderId(null)` reset). Both now use
  `btn-secondary btn-sm`, the same visible-button style used elsewhere in the app (e.g. the
  Cancel button in every modal).
- SW cache `ysc-v44` → `ysc-v45`.

### iOS keyboard-dismiss viewport gap fix (2026-07-18, same day)

User-reported (with screenshot) from the Prayers screen: after typing in a text field and
dismissing the keyboard, a strip of body background appeared below the fixed bottom nav —
WebKit had left it laid out against the stale keyboard-open viewport height. Fixed with
`_fixViewportGap()` (next to `_positionNprog()`): a same-position `scrollTo` nudge on
`visualViewport.resize`, with a delegated `focusout` fallback, forces a relayout. Not
reproduced locally (no iOS device in this environment) — tuned from the report alone, so
re-verify against a fresh screenshot if it recurs rather than assuming this fully covers it.
SW cache `ysc-v45` → `ysc-v46`. See debug.md's "Mobile viewport / iOS Safari quirks" entry.

### General-prayer scoping + a real junior-leader access bug fixed (2026-07-18, same day)

A follow-up question ("which account types see a general prayer created by each account
type?") surfaced that general (no-student) prayers were completely unscoped — visible to
every account with `prayer:read`, i.e. everyone, regardless of who created it. User asked for
real scoping and found a second, more serious bug in the process.

- **General prayers now inherit a grade+gender domain from their creator.**
  `access-control.ts`'s `generalPrayerCreatorScope(actor, structure)` computes it at creation
  time (`grade` role → own grade(s)+gender; `quad` role → bracket grades ([7,8,9]/[10,11,12])
  + quad gender; `admin`/`director`/`leader` → `{grades:null, gender:null}`, meaning no
  boundary). `canAccessGeneralPrayer(viewer, createdByGrades, createdByGender, structure)` is
  the read-side check: `admin`/`director`/`leader` viewers always see everything; a `grade`/
  `quad` viewer needs a grade overlap AND (if both sides have one) a gender match with the
  creator's stored scope. Net effect: a grade account's general prayer stays within its own
  grade+gender; a quad's is visible to every grade within its bracket+gender (and to other
  quads/grades that happen to overlap); admin/director-created ones stay ministry-wide, same
  as before. New nullable columns `created_by_grades` (jsonb)/`created_by_gender` (text) on
  `prayer_requests` (migration `0007`, additive) — existing rows are `NULL`/`NULL`, which
  reads as "no boundary" (backward-compatible: prayers created before this shipped stay
  visible to everyone, not retroactively hidden). Enforced on **both** `list()` (read) and
  `update`/`setStatus`/`remove` (write) — not just visibility, so a grade/quad actor can't act
  on a general prayer outside their own domain even by guessing/enumerating its id.
- **Real bug found and fixed: a junior `leader` could never see or create a prayer for even
  their own connected student.** `canAccessStudent()` → `canAccessGrade()`'s switch statement
  only handles `admin`/`director`/`grade`/`quad` — role `leader` falls to `default: return
  false`, unconditionally, for every grade. Every other service that scopes the `leader` role
  (`student.service.ts`, `atrisk.service.ts`, `connection.service.ts`) special-cases
  `actor.role === 'leader'` and resolves their own connected students via `connRepo` instead
  of `canAccessStudent` — `prayer.service.ts` never got that treatment, so any student-linked
  prayer create/read/edit by a `leader` actor threw `ForbiddenError`, even for their own
  connections. This was untested (`prayer.access-control.test.ts` only asserted the coarse
  `can()` RBAC grant, never the actual scoping) and undocumented until this fix. `makePrayerService`
  now takes an optional 4th `connRepo: IConnectionRepository` param (wired in `container.ts`);
  a `leader` actor's student-linked reads/writes now resolve via
  `connRepo.findByStudentAndLeader`/`findByLeader` instead of `canAccessStudent`.
- **Deliberately left open**: a `leader`-created general prayer stays visible to everyone
  (same as admin/director) — a junior leader is bound to one `Leader` record, not a grade/
  gender cohort, so there's no boundary to derive. Not asked for either direction; flagging in
  case a future request wants leader-created general prayers scoped some other way (e.g. to
  just that leader's own connected students' grades/genders).
- Tests: `prayer.access-control.test.ts` gained `generalPrayerCreatorScope`/
  `canAccessGeneralPrayer` coverage; `prayer.service.test.ts`'s old "visible to everyone" test
  (asserting the now-wrong unscoped behavior) was replaced with the full scoping matrix
  (grade/quad/admin-director creators × grade/quad/admin-director viewers) plus two new tests
  for the junior-leader fix. 357 → 366 tests.

### Incident: every /prayers request has been silently misrouted since the feature shipped (2026-07-18)

The admin tried to add a prayer and got a generic failure toast. Vercel runtime logs showed
**zero** `/prayers` requests ever reaching the function (`get_runtime_logs` grouped by
`requestPath` over the last 2h listed every other route the admin's session hit, never
`/prayers`) — the request wasn't crashing server-side, it was never arriving.

- **Root cause**: `vercel.json`'s `routes[]` has its own explicit allowlist regex
  (`^/(auth|students|leaders|...)`) separate from Express's `router.ts` and `sw.js`'s
  `API_RE` — routing at Vercel's edge happens *before* the request ever reaches
  `/api/index.ts`. This morning's Prayers feature work added `prayers` to the Express router
  and to `sw.js`'s `API_RE` (both correct, both tested) but never to `vercel.json` — the exact
  same class of bug as the 2026-07-11 `/manifest.json` incident documented earlier in this
  file ("a new top-level route served by the function on Vercel must be added to
  `vercel.json` routes[], not just the Express router"), which apparently didn't stick as a
  checklist item. Any unmatched path falls through `{"handle":"filesystem"}` to the catch-all
  `{"src":"/(.*)","dest":"/index.html"}` — so `GET /prayers` was returning the raw SPA HTML
  shell with a **200**, not an error. `API.post('/prayers', ...)` then called `res.json()` on
  HTML (not JSON), threw, and surfaced as a generic toast — nothing about the failure pointed
  at "wrong route" from the client side alone.
- **Fix**: added `prayers` to `vercel.json`'s regex. Verified directly with `curl` (not just
  typecheck/tests, which can't catch this class of bug at all — it's pure infra routing):
  `GET /prayers` now returns `401 {"code":"UNAUTHORIZED",...}`, matching every other
  protected route, instead of `200 text/html`.
- **Process gap this exposes**: my own post-deploy health checks for every prayers-related
  deploy today checked `/`, `/auth/me`, `/settings`, `/manifest.json` — never `/prayers`
  itself, so this shipped silently through 5+ deploys before a real user hit it.
  **Lesson for next time a new top-level API resource is added anywhere in this app: verify
  the exact new route with `curl` post-deploy (check for JSON + the expected auth status
  code, not just "some 2xx/4xx came back"), not just adjacent/already-covered routes.**
  Consider adding an automated check (e.g. a smoke-test script hitting every `SECTION_OF`/
  route-table entry) rather than relying on someone remembering this by hand a third time.

## Security notes

- **XSS:** all user-supplied strings (names, usernames, notification title/message,
  lifegroup names) are HTML-escaped via the global `esc()` helper before going into
  `innerHTML`. A `Content-Security-Policy` meta tag in `index.html` is defence-in-depth
  (`'unsafe-inline'` is required by the inline-script/onclick architecture; its value is
  blocking external script/resource loads + base-uri/form-action). **Always wrap new
  user-data interpolations in `esc()`.** Residual gap: a few `onclick` handlers pass names
  as JS-string args with only `'`-escaping — don't widen that surface.
- **Session token** is stored in `localStorage` (`yap_token`). Accepted risk, mitigated by
  the escaping + CSP above; switch to an httpOnly cookie if that ever regresses. Admin account
  preview (2026-07-12) stashes a SECOND live token alongside it during a preview session — its
  TTL is deliberately short (`PREVIEW_TOKEN_TTL_MS`, 1h) specifically to bound that extra window;
  see "Independent review follow-up" above.
- **Admin-supplied branding markup**: the one raw-`innerHTML` custom-branding path
  (`branding.logoSvg`, rendered unescaped by design so admins could paste `<svg>` markup) was
  **removed entirely 2026-07-12** after an independent review found its denylist sanitiser didn't
  catch unquoted event-handler attributes (`<svg onload=alert(1)>`) — see "Independent review
  follow-up" above. `branding.logoImage` (a raster data URI, no markup) is the only custom-logo
  path now. If a future change ever reintroduces raw markup rendered via `innerHTML`, use a real
  sanitiser (e.g. a proper SVG-profile DOMPurify build), not a hand-rolled regex denylist.
- **CORS:** in production, `CORS_ORIGINS` defaults to the prod domain (never `*`); override
  via env. **`SESSION_SECRET` must be set in production** or tokens can be forged.
- **Never commit Supabase CLI local state.** `supabase/.temp/` is gitignored (2026-07-03) — it
  holds the linked-project ref / pooler URL / tool versions and must stay out of git. Use explicit
  paths (not `git add -A`) when committing so untracked local dirs (`supabase/.temp/`, `_design/`)
  aren't swept in.
- **Forced password change (2026-07-09).** `User.mustChangePassword` / `Actor.mustChangePassword`
  is embedded in the signed session token (`toActor()` in `auth.service.ts`) and enforced in
  `express-adapter.ts` right after `resolveContext`: any route without `allowMustChangePassword:
  true` on its `Route` entry throws `MustChangePasswordError` (403, code `MUST_CHANGE_PASSWORD`)
  for a flagged actor. Only `GET /auth/me`, `POST /auth/logout`, and `POST
  /accounts/me/password` are allowlisted. The frontend mirrors this in `render()` — a flagged
  `S.user` gets `renderMustChangePassword()` (full-page, blocks the whole app) instead of the
  normal shell. `changeOwnPassword` is the only path that clears the flag; `create()` defaults
  new admin-created accounts to `false` (not in scope — see migration 017's comment for why the
  scope is deliberately narrow: only the historically-seeded accounts, not every admin-set
  password). This exists because `002_seed_admin.sql` / `005_seed_users.sql` and this file used
  to document a shared default password in plaintext next to real account usernames, in a *public*
  repo — see `017_must_change_password.sql`.
  **Gotcha (fixed 2026-07-11):** because the flag is baked into the token at login and
  `resolveToken()` trusts it with no DB re-check, clearing the DB flag alone left the
  caller's existing token still enforcing the gate for the rest of its 12h TTL (blank
  page after "Set Password & Continue" — needed a manual sign-out/back-in to get a
  fresh token). Fixed by `AuthService.issueTokenFor(userId)` minting a new token from
  current DB state; `POST /accounts/me/password` returns it and both frontend call
  sites swap to it via `API.setToken()`. If a similar per-token claim is ever added,
  it needs this same refresh-on-change treatment or it'll reproduce this bug.
