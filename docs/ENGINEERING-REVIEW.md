# Connection Made Simple — Engineering Review

_External review + record of the work done in the overnight session of 2026-06-13._

This document has four parts:
1. **What shipped this session** — the fixes, with commits.
2. **Efficiency audit** — making the app run smoother.
3. **UX audit** — a smoother, more enjoyable experience.
4. **Data-porting assessment** — JSON / local pre-processing vs the current DB approach, with a recommendation.

---

## 1. What shipped this session (all on `master`, auto-deployed)

| Commit | Change |
|--------|--------|
| `a59e698` | Home: removed "Last Import" card; locked viewport (no pinch-zoom); clipped horizontal overflow. |
| `acccd97` | **Resilience fix (the big one):** DB pool `max:1 → 5`; longer import client timeout. |
| `52c57ed` | Avg/wk corrected; reset switched to `TRUNCATE`. |
| `7700e4d` | Averages on the valid-services basis (≥100 attendees = a real service); `serviceMinAttendance` setting + migration 008; flows into at-risk and CA "Regular". |
| `67e3278` | Trends page: added the weekly-attendance chart; removed the big tiles from by-quad/by-grade. |
| `d13c28a` | Leaders & Connect now routes to the per-leader card view (per-leader "Add Students"); folded in Add/Edit/Delete leader. |

**Root causes found (not just symptoms):**

- **App-wide freezing / "can't log back in for 20–30s" / intermittent import timeouts** → the postgres pool was `max:1`. One slow query (an import, or `/trends` scanning 21k attendance rows) held the *only* connection and blocked every other request in that serverless instance, including `/auth/login`. The Supabase transaction pooler multiplexes, so `max:5` is safe and removes the head-of-line blocking. **This was the single highest-impact fix.**
- **Lifegroup import "timeout"** → *not* the import. The full 24-group dataset imports in ~1.8s directly against the live DB. It was the pool contention above, plus a 20s client abort on cold starts.
- **Avg/wk wrong** → 19 of 35 sessions were empty (future-dated columns + term breaks), and the old logic averaged over them. Now a "valid service" is a Friday with ≥ `serviceMinAttendance` (default 100) total attendance; everything else is disregarded. One global mask keeps ministry/quad/grade additive.
- **Resets "didn't work"** → row-by-row `DELETE` loops hit the 15s statement timeout. Now single `TRUNCATE … CASCADE`.
- **Trends graph "not showing"** → the `colChart` helper existed but was never called and the page never fetched `/trends`. Now wired up.
- **Global "Connect Students" button** → the good per-leader view was dead code (defined, never routed). Now it's the live page.

---

## 2. Efficiency audit

### Resolved this session
- DB connection pool (the freeze cascade).
- Reset/new-year via TRUNCATE.
- Bulk imports chunked to 1,000 rows (avoids the 65,535 bind-parameter ceiling).
- Actor embedded in the signed token → no `users.findById` on every authenticated request.
- Sydney region pin (co-locates the function with the DB).

### Still worth doing (prioritised)

**P1 — `/trends` pulls the entire `service_attendance` table on every load.**
`trendsService.get()` does `attendanceRepo.findAll()` (21k+ rows today, grows every term) and aggregates in JS. This is the heaviest read in the app. Replace with a SQL aggregation that returns per-session attended counts grouped by session (and, if needed, by quad/grade), e.g. `SELECT session_id, count(*) FILTER (WHERE attended) … GROUP BY session_id`. Cuts payload and CPU dramatically and scales with terms.

**P1 — Service import should *replace*, not leave stale sessions.**
Each service import now recomputes student svc counts over *that import's* valid sessions, but prior sessions are left in `service_sessions`. For a full-year re-import this means the trends chart can show duplicate/old weeks. Fix: at the start of `importServiceCsv`, clear prior service sessions + attendance (they cascade), then import fresh. Same authoritative model the student aggregates already assume.

**P2 — Lifegroup weeks are duplicated per group.**
The 24-group import wrote 1,656 `lifegroup_weeks` rows (24 × 69 dates) — the same dates repeated per group. Dedupe weeks by date (one row per meeting date), or key attendance by `(lifegroup_id, date)` and drop the per-group week explosion. ~24× fewer week rows.

**P2 — `getSettings()` runs an upsert on every settings read.**
It's a single fast query, but it writes (INSERT … ON CONFLICT) on a pure read path. Consider a plain SELECT with lazy-create only when missing.

**P3 — Express 4 `url.parse()` DEP0169 warning.**
Benign; comes from Express 4's `parseurl` dependency on newer Node, not our code. Only resolved by an Express 4→5 upgrade (breaking) — not worth it now. Documented so it isn't chased again.

**P3 — `renderLeaders` is now dead code.**
Safe to delete (its helpers `showAddLeader`/`showEditLeader`/`confirmDelLeader`/`showLeaderDetail` are still used and stay).

---

## 3. UX audit (for a smoother, more enjoyable experience)

**Perceived performance**
- The client cache + post-login prefetch are good. With `max:5`, prefetch now actually parallelises. Consider a tiny skeleton/shimmer instead of a centered spinner on first loads — it reads as faster.
- Navigations already reuse the persistent shell. Keep that invariant; don't introduce full re-renders.

**Clarity of numbers**
- "Avg/session", "Avg sessions/student", and "Avg/wk" appear in different places with subtly different meanings. Pick one canonical phrasing per concept and a one-line tooltip ("average attendance across the N valid Fridays this term"). The new ≥100 rule makes these defensible — surface *why* a week was excluded (e.g. a muted "3 weeks excluded (holiday/low)") so the numbers feel trustworthy.
- The at-risk distribution shifted to ~52% at-risk/stopped under the strict 75% "regular" threshold. That's mathematically correct but may feel alarming. Consider showing the threshold inline ("Regular = attended ≥ 75% of 14 services") and/or a gentler default (e.g. 2/3).

**Connect flow**
- Per-leader "Add Students" is now the model — good. Next: show a capacity/coverage signal per leader (already partially there via the target bar) and a one-tap "unconnected only" focus (exists). Consider surfacing unconnected students prominently at the top.

**Mobile polish**
- Viewport is now locked (no pinch-zoom) and overflow clipped. Verify on a real device that the sticky header + bottom nav leave enough safe-area padding (`env(safe-area-inset-*)` is used; spot-check on a notched phone).
- Tap targets in dense tables: the desktop tables are fine, but ensure card-view buttons are ≥40px.

**Trust & feedback**
- Import results toast is good. Add an explicit "X students, Y leaders, Z connections" summary on the home hero so an admin can confirm data loaded correctly at a glance.

---

## 4. Data-porting assessment (JSON / local pre-processing vs DB)

**Question:** should the app lean more on structured JSON files and/or do more processing in the import HTML before sending to the DB?

**Finding:** the motivation for this (import timeouts) was a **connection-pool** problem, now fixed. Imports are fast (1.8s for the full dataset). So a move away from the DB is **not warranted** — the layered DB architecture is sound and the read features (per-lifegroup attendance on the student profile, "My Students", per-lifegroup stats) genuinely need the relational data.

**Recommendation: keep the DB; apply *targeted* pre-aggregation, not a rewrite.**

The valuable, low-risk version of "more local processing" is:

1. **Compute aggregates client-side and send them alongside the rows.** The browser already parses the CSV; have it also compute per-student svc/grp totals and per-session totals, and POST those as a compact summary. The server then writes aggregates directly instead of recomputing. Saves server CPU and makes the student-row numbers authoritative without a second pass.
2. **Dedupe lifegroup weeks at parse time** (P2 above) — one week per date, not per group.
3. **Keep granular attendance** (service + lifegroup) in the DB — it's needed for trends and the per-lifegroup views, and it's cheap to write in chunks.

What to **avoid**: storing primary data in JSON files / localStorage as the system of record. It breaks multi-user consistency, the at-risk/trends queries, and the RBAC model. (The Connection Audit module's localStorage is fine — it's a per-user scratchpad, not shared data.)

**If you later want true offline/local-first**, the right shape is the existing repository interface with an IndexedDB implementation behind a sync layer — a separate project, not a tweak to the import.

---

## Suggested next session order
1. P1: `/trends` SQL aggregation (biggest remaining perf win).
2. P1: service import = replace semantics (correctness for re-imports).
3. P2: dedupe lifegroup weeks.
4. UX: number-phrasing pass + "weeks excluded" transparency.
5. Optional: client-side aggregate pre-computation on import.

---

## Session 2 (2026-06-14) — shipped

- **Lifegroup import reworked**: Monday–Sunday week bucketing (a group meeting twice
  in a week counts once); per-student grp = weeks attended ÷ weeks the group ran;
  **replace semantics** (keeps students + connections); **0-attendance members are
  not counted as part of the group**; roll entries with "(leader)" create/ensure a
  Leader (grade+gender from the group name) and are excluded from youth attendance.
- **Service import**: replace semantics + at-risk recomputed from svc AND group.
- **Connect picker**: defaults to the leader's own grade(s)+gender; no-grade/no-gender
  hidden until searched by name; added a Done button.
- **Trends/home unified** on `/trends` (avg students per valid week) so the numbers
  reconcile; removed "avg sessions/student" and group roster/"enrolled" size; per-grade
  dropdown shows service (uniq+avg/wk) + group (uniq); lifegroups tab shows uniq + avg %.
- **Bottom nav** is now `position:fixed` (was floating up on short pages).

## Remaining (next session) — see task #18

1. **This-term / previous-term split (BIGGEST).** Spec confirmed: term boundaries from
   service-date gaps > `termGapDays` (current + previous); same boundaries for groups;
   holiday-break group weeks excluded; this-term default + previous as comparison;
   term-scoped uniques. Touches import (populate `prevSvc*`/`prevGrp*`), trends/overview/
   at-risk, and the SPA. The data model (`prev*` fields, `svcTrend`) already supports it.
2. **Per-grade GROUP avg-students/week** — needs group session aggregation (a `/trends`
   extension); currently the per-grade dropdown shows group *unique* only.
3. **`/trends` SQL aggregation** (perf — still pulls full attendance table in JS).
4. **Audit home-page group metrics** for any lingering avg-sessions/student phrasing.
5. **Live data**: grp figures update on the next lifegroup re-import; svc on the next
   service re-import (both now authoritative replacements).
