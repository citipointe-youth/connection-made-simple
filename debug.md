# debug.md — Connection Made Simple debugging map

> Companion to `CLAUDE.md`. Read **both** when picking up a bug report.
> CLAUDE.md = system/architecture/contract + the dated changelog of what shipped and why.
> This file = "where does this symptom live?" — a fast router, not a duplicate of CLAUDE.md.

## How to use this file (per bug report)

1. Read `CLAUDE.md` + this file. **Don't read the rest of `public/index.html` yet.**
2. From the **symptom router** below, jump to the one function/file that owns it.
3. **Confirm by Grep on the function/class name** — this file gives you the symbol to search
   for, not a trustworthy line number (they drift every time `index.html` is edited).
4. Read only that function's range (`Read` with `offset`/`limit`, or `Grep -A`/`-B`). Most SPA
   bugs live in one function.

> **Verify & deploy conventions (this repo):**
> - Primary gate: `npm run typecheck` + `npm run test` (186+ tests). Both must be clean before
>   calling anything done.
> - Browser verification (via the Chrome extension) is worthwhile here for UI/scroll/CSS
>   changes and has caught real issues in past sessions — but it's confirmatory, not a
>   substitute for typecheck/test, and the extension is occasionally flaky (screenshot timeouts
>   that resolve on retry/new tab — not usually a real app hang; cross-check with
>   `get_page_text` or `read_console_messages` before assuming a JS bug).
> - GitHub (`citipointe-youth/connection-made-simple`) is linked to Vercel — **a push to
>   `master` IS the deploy.** No need to poll Vercel or curl prod to confirm it shipped; a
>   `curl .../health` right after push is a reasonable one-off sanity check, not a routine step.
> - Before any destructive local testing (Full Reset, admin/reset), use `PERSISTENCE=memory`
>   locally — never test destructive admin actions against the real Supabase-backed prod data.

### Per-bug input template

```
Read CLAUDE.md and debug.md. Don't read other files yet.
Account: <email> (role: grade | quad | director | admin)
Screen: <where you saw it>
Bug(s):
1. <symptom — what you saw vs expected>
```

Role decides RBAC scope; screen usually narrows straight to a symptom-router entry below.

---

## Symptom router

### Connection Audit — funnel / ladder / "Interacted" numbers look wrong

- **"Interacted" equals "Came to Youth"** (or any two adjacent rungs collapse to the same
  number): almost always **missing overlay data**, not a stage-math bug. `model()`
  (`public/index.html`, inside the `CA` module IIFE) builds `marks` from
  `st.uploads.team/connect/decision.rows` — if Team/Connect/Decision CSVs weren't (re-)staged
  on the last save, `saveAudit()`'s `carry()` fallback should have preserved the prior year's
  data; check the Data tab shows "N rows carried over from `<year>`" for those slots. If it
  shows nothing carried AND nothing staged, the data really is gone for that year (re-upload).
- **Quad-level funnel breakdown doesn't match the overall funnel** (e.g. overall shows
  Interacted > Came to Youth but every quad panel shows them equal): unmatched (`caOnly`)
  people need grade+gender in the uploaded Connect/Decision CSV to get a `computeQuad()`
  result — grep `computeQuad` and the `people.push(...quad)` call sites in `model()`. Rungs
  filtered by quad should read `p.quad`, never `p.s.quad` (the latter is null for `caOnly`
  people) — the one deliberate exception is `exportQuad()`'s follow-up CSV, which needs a real
  student's `gT`/`grade`/`ph` and can't include `caOnly` people at all.
- **A specific stage looks wrong for one student**: the whole stage ladder is one line in
  `model()` — grep `const stage=(teamActive&&s.gA>0)?5:`. Team requires `s.gA>0` too (a team
  member who isn't currently in a lifegroup is capped below stage 5, on purpose — see the
  comment right above it).
- **Executive brief / deck numbers disagree with the on-screen Overview/Funnel**: they
  shouldn't — `_buildDeckBody()` calls the same `model()`. If they diverge, suspect the deck
  is using a stale `TERM`/`AUDIT` (check `buildDeck(termOverride)`'s prior-state swap/restore).

### Connection Audit — Data tab / upload

- **A re-upload wiped Team/Connect/Decision(/Flows) for that year**: `saveAudit()`'s `carry()`
  helper — grep `const carry=(kind)=>`. It only carries forward when `AUDIT`/`AUDIT_YEAR` is
  the year actually being saved; check the admin didn't switch years mid-upload.
- **Grade/gender not being read from a Connect/Decision CSV**: `parseRows`/`parseMatrixRows`
  (public/index.html) — both look for `grade`/`school grade` and `gender` headers, optional
  (absent on exports that don't have them). `CA.upload(kind, input)` dispatches to one or the
  other depending on file shape.
- **New Year Refresh wizard step stuck / wrong step unlocked**: `_wiz` state object + the 6
  `_wizStepCard` calls in `renderNewYearWizard()` — steps gate strictly in order
  (`step1Done`→`step6Done`). `_wizReset()` only runs when the tab is re-opened, not on save.
- **Full Reset didn't actually clear everything**: `admin.service.ts` `reset()` — confirm it
  still wipes `connection_audits` (added 2026-07-09; a regression here would silently leave
  last year's per-student snapshot behind after a "full" reset).
- **Audit backup/restore (export-all / import-all) 404s or hits the wrong handler**: route
  order in `router.ts` — `/audits/export-all` and `/audits/import-all` (and `/audits/
  finalize-live`) MUST be registered before `/audits/:year`, since Express matches routes in
  registration order and a param route registered first swallows the static ones.

### Connect Setup screen

- **Page scrolls to the top after closing "Add Students"**: `pickerSyncBg()` should be called
  **once**, from `openStudentPicker`'s `onClose` callback — not per add/remove. If it's back to
  being called inside `addConnFromPicker`/`remPick`, that's the regression (repeated
  background re-renders while the modal is open clobber `window.scrollY` by the time it
  closes).
- **A leader's grade/gender checkboxes look wrong when a grade/quad login edits them**:
  `showEditLeader()` — `canBroadenGrades`/`lockGender` gate whether gender is a free `<select>`
  or a disabled one. All 6 grade checkboxes should always show for every role (grades are
  never restricted in the edit UI, only gender is locked for grade/quad).
- **A grade/quad login can't broaden a leader's grades** (403 / no effect): `submitEditLeader()`
  should route grades through `PATCH /leaders/:id/grades` (`LeaderService.updateGrades` —
  deliberately skips the creator/quad-scope ownership check `update()` enforces), not the
  general `PATCH /leaders/:id`. Name/active going through the general endpoint are
  best-effort for these two roles and silently no-op if you don't own the leader — that's
  expected, not a bug.
- **Bottom of every screen has a large dead white gap**: `.pg`'s `padding` bottom value (CSS
  near the top of `public/index.html`) — halved 2026-07-09 (was `76px`, more than the mobile
  bottom-nav it exists to clear, and pure dead space on desktop where that nav is hidden).
- **A leader broadened to a second grade still can't be shown that grade's students in "Add
  Students"**: the picker's pool (`_aS.students`) and the leader-card connected counts
  (`_aS.allocs`) come from `GET /students`/`GET /connections`, which — separately from the
  Leader record's own `grades` — are scoped server-side to the *actor's* own grade/bracket
  (`student.service.ts` `list()`, `connection.service.ts` `listAll()`). Grep `crossGrade`:
  Connect Setup requests `?crossGrade=1` on both (see `CONNECT_PATHS`), which relaxes that
  scoping to "own gender only" so the broadened grade's students actually reach the client;
  the picker's own default-view filter (`window._pickerGrades`, from the *leader's* `grades`)
  then narrows it back down to just that leader's assigned grade(s). If this regresses, check
  `SECTION_OF`/`CONNECT_PATHS` still point at the `?crossGrade=1` paths, not plain
  `/students`/`/connections` — the plain ones must stay grade-scoped for every other screen.
- **Add Students picker shows the wrong grade at the top of a bucket**: `_pickByOwnGradeFirst`
  sorts each of the three buckets so the logged-in login's own grade(s) — not the leader's —
  come first; it reads `window._pickerOwnGrades`, set in `openStudentPicker()` from
  `S.user.grade` (grade role) or `quadGrades(S.user.quad)` (quad role). Admin/director have no
  "home grade" so this is a no-op for them (falls back to plain first-name order).

### Student profile modal (`showStudentDetail`)

- **Leader Assignments (already-connected list) shows a scrollbar / gender+grade**: it
  shouldn't — that list is meant to be plain/uncapped. The capped ~2.5-row scrollable preview
  belongs on the **"search a leader to assign"** results (`sdLeaderSearch()` → `#sd-llist`,
  class `.leader-assign-list`), which also shouldn't show gender/grade. If these two got
  swapped again, that's the same mistake made once already this project's life — check
  `assignedHtml` (plain map, no wrapper) vs `sdLeaderSearch()`'s `el.innerHTML` (wrapped,
  name-only rows).
- **"Connect →" button reappears at the bottom**: it was deliberately removed (2026-07-09) —
  the modal's only action button should be "Close".

### Health tab (`renderAtRisk`)

- **Tooltip too technical for a non-technical leader**: the `helpTip(...)` next to the "Health"
  heading — keep it in plain language (no "stream"/"rate"/"20-point swing" jargon); the
  underlying model (`computeStatus` in `atrisk.service.ts` / `_arQualChips`) is
  threshold-free and shouldn't need to change just because the tooltip wording does.
- **Card's profile icon does nothing / wrong student**: the `onclick="showStudentDetail('${s.id}')"`
  button added to each card in the `AR_SEC` loop, bottom-right, `position:absolute`.

### Accounts / passwords

- **Admin's "Reset password" doesn't show the new password afterward**: `submitSetPassword()`
  should open a follow-up modal with a copyable `<input readonly>`, not just a toast — the
  value can never be retrieved again since it's bcrypt-hashed one-way.
- **Self-service "Reset Password" (Connect Setup, key icon) fails**: `POST /accounts/me/password`
  (`AccountService.changeOwnPassword`) — verifies the CURRENT password server-side; requires no
  `admin:manage` permission (any authenticated actor can change their own). Distinct from
  `POST /accounts/users/password` (admin resetting someone else).

### RBAC / scoping (backend)

- **A role can/can't do something and you're not sure why**: `src/services/access-control.ts`
  is the ONLY place role→permission mappings live — grep the `Action` union and
  `ROLE_PERMISSIONS`, don't chase role checks scattered through services.
- **A grade/quad login is blocked from editing a leader they'd expect to own**: `leader.
  service.ts` `update()`'s ownership check (`createdByGrade !== actor.grade` for grade role;
  `assertLeaderInQuadScope` for quad) — most real leaders are auto-created by CSV import
  (`createdByGrade: null`), so this blocks almost everyone by design. The **only** two
  endpoints that deliberately skip it are `updateSmsTemplate` and `updateGrades` — both have a
  comment explaining why (no server-side binding between an Actor and "the leader they
  identify as").

### Production performance / DB connection issues

Don't re-diagnose from scratch — CLAUDE.md's "Production performance incident" section (search
for "RESOLVED — the actual root cause was the pooler CONNECTION MODE") has the full multi-day
investigation, dead ends, and the actual fix (session-mode pooler + per-account rate limiting).
The mitigation levers (idle_timeout, pool size, `max`) are listed there too — check that section
before touching `client.ts`'s pool config.
