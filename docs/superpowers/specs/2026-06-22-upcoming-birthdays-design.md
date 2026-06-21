# Upcoming Birthdays — Design Spec

**Date:** 2026-06-22
**Status:** Approved (design); spec-review gate skipped at user request.

## Goal

Add a new **Upcoming Birthdays** screen to the SPA, reachable from a Home **quick-action** button on the **grade login**. It lists every student in the grade login's scope whose birthday falls between today and two months from today — independent of which leader is self-identified in the app.

## Scope decision

"All members of the grade" = the **grade login's own role scope** (grade + the login's gender). A gendered grade login (`grade7g`) sees only grade-7 girls; an ungendered grade login (`grade7@`, `gender: null`) sees both genders. No RBAC change — this is exactly what `GET /students` already returns for that login. ("Regardless of self-identified leader" is satisfied automatically because we read `/students`, not the leader summary.)

## Approach

Pure client-side, reusing the existing role-scoped `GET /students` (which returns `dateOfBirth`). No backend changes, no new endpoint, no new tests beyond manual verification. All changes live in `public/index.html`.

## Behaviour

- **Window:** for each student with a `dateOfBirth`, compute the **next occurrence** of their birthday on/after today (month + day, year ignored). Include the student if that occurrence is **on or before `today + 2 calendar months`**. Computing against the next occurrence makes the year-wrap (e.g. late-Nov → Jan) and the sort order fall out for free.
- **Sort:** ascending by next-occurrence date.
- **Grouping:** group rows by calendar month header (e.g. "June", "July", "August").
- **Row content:** student name; weekday + day + month of the upcoming birthday (e.g. "Fri 3 Jul"); "turns N" when the birth year is known; tap-to-call for mobile/parent phone, consistent with My Students.
- **Excluded:** students with no `dateOfBirth`.
- **Empty state:** "No birthdays in the next 2 months."
- **Caching/spinner:** reuse the `_allCached('/students')` pattern — render immediately when cached, spinner only on a cold fetch.

## Access / navigation

- Add an `Upcoming Birthdays` item to the **grade** branch of `navItems()` in the **quick-actions** section (index ≥ 4), so it appears as a Home quick-action tile and a desktop side-nav link, NOT in the bottom nav. Other roles are unchanged.
- New page id: `birthdays`. Route it in `render()` → `renderUpcomingBirthdays()`.
- Add one new inline-SVG icon to the `IC` registry (a calendar/gift glyph). No emoji or Unicode symbols (SPA convention).

## Components (all in `public/index.html`)

- `navItems()` — add the grade quick action `{ id:'birthdays', ic:'cake', label:'Upcoming Birthdays', mbl:'Birthdays' }`.
- `render()` — `else if (p==='birthdays') await renderUpcomingBirthdays();`
- `IC` — add a `cake` (calendar/gift) path; reachable via `icN`/`icS`.
- `_nextBirthday(dob, today)` — returns a `Date` for the next on/after-today occurrence of the birthday, or `null` for missing/invalid input.
- `_fmtUpcoming(date)` — returns `{ weekday, day, month, monthName }` parts for display.
- `renderUpcomingBirthdays()` — fetch `/students` (cached), filter to the 2-month window, sort, group by month, render; tap-to-call via existing `phoneLink`.

## Edge cases

- **Year wrap:** handled by next-occurrence computation.
- **29 Feb birthday in a non-leap year:** the next occurrence rolls to the following 29 Feb; acceptable (rare). Use date arithmetic that does not throw.
- **No DOB:** excluded from the list.
- **Birth year unknown / only month-day stored:** show the date without "turns N".

## Out of scope

- Showing other roles' birthdays screens (grade login only for now; the render function is role-agnostic so it could be extended later).
- Any backend endpoint or notification/reminder integration.
