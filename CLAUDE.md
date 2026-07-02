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
npm run test         # vitest (177 tests)
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
- **Term filtering in the SPA (`model()`):** connect/decision rows are filtered by `inPeriod(r.date)` against the selected term's `startDate`/`endDate` (ISO string comparison). Undated rows are always included. Team rows carry no dates — for a specific term, a team member only reaches stage 5 if they also attended that term (`sA>0 || gA>0`); YTD counts the full roster.
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

### SPA architecture

**Persistent shell** — header + nav are built once on login via `_initShell()` and never rebuilt. All page navigations update only `<main id="page-main">` via `setApp(h)`. The `_shellReady` flag gates this; set to `false` on logout.

**Client-side cache** — `Cache` object (30-second TTL) wraps all `API.get()` calls. Cache is invalidated on every write (connections, leaders, settings, import, admin, users). After login `_prefetch()` fires background fetches for all 7 common endpoints so navigations after the first are instant.

**Stale-while-revalidate navigation** — every page render function (`renderHome`, `renderTrends`, `renderConnect`, `renderUpcomingBirthdays`, `renderMyStudents`, `renderStudents`, `renderAtRisk`, `renderImport`, `renderAdmin`, plus the CA module's own pages) follows the same `<PAGE>_PATHS` + `allFresh`/`haveStale` pattern: all-fresh renders straight from cache; any-stale paints instantly from `Cache.getStale(...)` and revalidates in the background via a `_revalidate<Page>()` helper that re-renders only if `S.page` hasn't changed; nothing cached at all shows the spinner. `renderLeaders`/`renderQuadView`/`renderMyQuad`/`renderNotifications` are dead/unreachable code (not in the `render()` dispatch table) and were deliberately left on the old `_allCached` pattern.

**Global loading bar (`#nprog`)** — a thin accent-coloured bar under the top edge, reference-counted via `_npStart`/`_npDone` called from the `API` IIFE's `r()`. Since `API.get` only calls `r()` on a cache miss, cached reads never trigger it — only real network requests do.

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

- Cache name: `cms-v11` (bump on breaking changes to force eviction)
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
