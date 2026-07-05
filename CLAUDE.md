# CLAUDE.md — Connection Made Simple

> **Scope:** the real **Connection Made Simple** app — TS/Express backend (`src/`) + `public/index.html` SPA. The offline demo and its full UI conventions live in `../youth app demo/CLAUDE.md`; this SPA is kept aligned to that demo. Project map: `../CLAUDE.md`.

Guidance for Claude Code when working in this package.

## What this is

**Connection Made Simple** (`connection-made-simple`) — a youth ministry platform for YS Brisbane. Phone-first SPA backed by a TypeScript/Express API. Students are *connected* to leaders; "connection" is the core relationship entity. Backend-agnostic architecture identical in structure to the Youth Camp Platform.

- **GitHub:** `citipointe-youth/connection-made-simple` (migrated from `987tom1` 2026-06-22; org now owns the GitHub repo, Supabase org, and Vercel team)
- **Deployed:** https://connection-made-simple.vercel.app (Vercel team `citipointe-youth`; auto-deploys from `master`)
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
| Students | `GET/POST /students`, `GET /students/search`, `GET/PATCH/DELETE /students/:id` |
| Leaders | `GET/POST /leaders`, `GET/PATCH/DELETE /leaders/:id`, `PATCH /leaders/:id/sms-template` (self-service, no ownership check — see the SMS templates note below) |
| Connections | `GET/POST /connections`, `GET /connections/export`, `GET /connections/student/:id`, `GET /connections/leader/:id`, `DELETE /connections/:studentId/:leaderId`, `GET /connections/allocations/export`, `POST /connections/allocations/import` (admin-only allocation CSV round-trip) |
| Overview | `GET /overview` |
| At-risk | `GET /at-risk`, `POST /at-risk/recompute` |
| Trends | `GET /trends` |
| Lifegroup stats | `GET /lifegroups/stats` (per-lifegroup/grade/quad/overall, current + previous term + weekly series), `GET /lifegroups/:id/members` (per-student attendance detail, current term — powers "click a lifegroup to see who attended") |
| Import | `POST /import/csv`, `GET /import/history`, `DELETE /import/history` (clear log), `DELETE /import/history/:id` (remove one) |
| Settings | `GET/PATCH /settings` |
| Admin | `POST /admin/reset` (clears students+leaders+connections+all data), `POST /admin/clear-service-group` (clears service/lifegroup data, **keeps** students+connections+leaders, resets student aggregates), `GET /admin/audit` (log kept; unreachable from the SPA since the Audit tab was removed) |
| Connection audits | `POST/GET /audits`, `GET/DELETE /audits/:year`, `POST /audits/finalize-live` (builds this year's snapshot from live tables, no CSV upload — used by the New Year Refresh wizard) |
| Accounts | `GET/POST /accounts/users`, `PATCH /accounts/users/:id`, etc. |

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

**GOTCHA — production `DATABASE_URL` must use the connection POOLER, not the direct
connection.** On Vercel serverless, the direct connection (`db.<ref>.supabase.co:5432`)
fails because Supabase now serves it over IPv6 only and Vercel functions are IPv4. Use the
Supavisor pooler (transaction mode), note the `postgres.<ref>` username and port `6543`:
`postgresql://postgres.<ref>:<password>@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres`.
Transaction mode means no session-level prepared statements — fine for this app.

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

**Gendered tile labels** — `_loginGender(u)` (quad→quad gender; grade→email `…g`/`…b`) +
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

- Cache name: `cms-v21` (bump on breaking changes to force eviction)
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

## Notifications (web push)

> **CURRENTLY HIDDEN** (as of 2026-06-27). The feature is fully implemented and all code
> is intact — only the UI entry points and the permission request have been disabled. To
> re-enable, see the **Re-enabling push notifications** section below.

- Backend: `push.service.ts` + `/push/*` routes (`vapid-key`, `subscribe`, `unsubscribe`,
  `send`, `notifications`, `notifications/:id` delete, `notifications/:id/dismiss`).
- **Targeting:** `all` (director/admin only), `quad`, `grade` (gendered). A **quad**
  notification fans out to the quad login **and** the gendered grade logins inside that
  quad (e.g. `g79` → `grade7g`/`grade8g`/`grade9g`) — see `getUsersForTarget`.
- **Expiry:** notifications expire **7 days** after creation (`send()` in `push.service.ts`).
- `findReceivedByUser` already filters out dismissed/deleted/expired, so the SPA unread
  count is just `received.length`.
- **SPA:** notifications live on their **own page** (`renderNotifications`, route
  `notifications`, in `navItems()` for every role incl. grade). The header **bell**
  navigates there and shows a red unread **badge** (`_updateNotifBadge`). Admin/director/
  quad get a **Send notification** button at the top of that page (`showSendNotification`).

## Re-enabling push notifications

All changes are in `public/index.html`. Search for `// PUSH-HIDDEN` to locate every
disabled touch point. There are five things to restore:

1. **Header bell button** — in the function that builds the persistent app shell
   (the function called after login that sets up the header, top nav, and bottom nav),
   restore the bell icon button that sits between the role badge and the logout button.
   It should navigate to the `notifications` route on click and contain an empty badge
   element (`id="notif-badge"`) that the badge-refresh function uses to show an unread
   count. The `PUSH-HIDDEN` comment marks where it was removed.

2. **Badge refresh on login** — in the same shell-building function, after it calls the
   prefetch helper, there was a call to `_updateNotifBadge()`. Uncomment it (marked
   `PUSH-HIDDEN`).

3. **Nav items for all roles** — in the function that returns the navigation item list
   (`navItems()`), each role's array (grade, quad, admin, director) had a `notifications`
   entry with the bell icon, labelled "Notifications" / "Alerts". Uncomment the four
   commented-out entries (each marked `PUSH-HIDDEN`).

4. **Route handler** — in the main page-routing function (`go()`), the `notifications`
   route currently redirects to home. Change it back to call `renderNotifications()`
   (marked `PUSH-HIDDEN` on the same line).

5. **Permission request on login** — in the login submit handler (`doLogin()`), the call
   to `initPushSubscription()` (which requests browser permission and registers the push
   subscription) was commented out. Uncomment it (marked `PUSH-HIDDEN`).

No changes are needed to the backend (`router.ts`, `push.service.ts`, etc.) or the
service worker (`public/sw.js`) — those were left fully intact.

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
  calls it). Deleting an account now requires typing its email to confirm.
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

## Security notes

- **XSS:** all user-supplied strings (names, emails, notification title/message,
  lifegroup names) are HTML-escaped via the global `esc()` helper before going into
  `innerHTML`. A `Content-Security-Policy` meta tag in `index.html` is defence-in-depth
  (`'unsafe-inline'` is required by the inline-script/onclick architecture; its value is
  blocking external script/resource loads + base-uri/form-action). **Always wrap new
  user-data interpolations in `esc()`.** Residual gap: a few `onclick` handlers pass names
  as JS-string args with only `'`-escaping — don't widen that surface.
- **Session token** is stored in `localStorage` (`yap_token`). Accepted risk, mitigated by
  the escaping + CSP above; switch to an httpOnly cookie if that ever regresses.
- **CORS:** in production, `CORS_ORIGINS` defaults to the prod domain (never `*`); override
  via env. **`SESSION_SECRET` must be set in production** or tokens can be forged.
- **Never commit Supabase CLI local state.** `supabase/.temp/` is gitignored (2026-07-03) — it
  holds the linked-project ref / pooler URL / tool versions and must stay out of git. Use explicit
  paths (not `git add -A`) when committing so untracked local dirs (`supabase/.temp/`, `_design/`)
  aren't swept in.
