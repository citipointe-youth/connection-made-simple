# Migration consolidation + seed username truncation — design

## Problem

Deploying YS Connection to a new church requires running 20 sequential SQL
migrations (`supabase/migrations/001…020`) in order. Most are small additive
changes (indexes, column adds/drops); a few are real schema/data changes. This
is more ceremony than a fresh deployment needs, and it's a barrier to onboarding
new churches.

Separately, the seed migrations (`002_seed_admin.sql`, `005_seed_users.sql`)
store login identity in an `email` column formatted as
`admin@youth.ministry`, `grade7f@youth.ministry`, etc. The app already treats
this field as a free-form username everywhere (SPA labels it "Username", Zod
validation is `z.string().min(1)` not an email format, `deriveActorGender`
defensively splits on `@`), so carrying a fake email domain through seed data
is vestigial. It should be a bare username (`admin`, `grade7g`).

A third issue surfaced during investigation: `docs/push_subscriptions.sql`
creates the `notifications` / `push_subscriptions` / `notification_recipients`
tables used by the (currently UI-hidden) push notification feature, but this
file is **not a tracked migration** and is never referenced by
`docs/DEPLOYING.md`. A fresh deployment following current instructions would
error at migration `016` (`alter table public.notifications enable row level
security`) because the table doesn't exist yet. This is now moot in a useful
way: **a separate Claude instance is concurrently removing the notifications
feature's application code** (told explicitly not to touch migrations), so
this work owns dropping the now-dead tables from the database.

## Constraints

- **Must not impact the live production system.** Prod (`ltcblcudlzlzfcyzlhpc`,
  citipointe-youth org) already has all 20 migrations applied, tracked in
  `supabase_migrations.schema_migrations`. Its actual schema/data must not
  change as a side effect of *file* consolidation — only the explicit,
  reviewed DROP (below) is allowed to touch prod data, and only once gated.
- Migrations are applied both via Supabase CLI (`db push`, tracked history)
  and via manual SQL-editor paste, depending on environment — the solution
  must work either way.
- Seed data truncation is scoped to the **SQL migration seed data** and,
  per user decision, **also** `src/seed.ts` (in-memory `PERSISTENCE=memory`
  dev/demo seed) and its dependent tests, for consistency. Not in scope:
  anything else.
- The notifications-table DROP is genuinely destructive (one-way data loss
  for any stored push subscriptions / notification history) and must not run
  against prod until the other instance's app-code removal has shipped.

## Approach

### 1. Consolidate `supabase/migrations/` into 4 files, archive the originals

```
supabase/
  migrations/
    0001_baseline_schema.sql    -- every table + index as of migration 020's
                                   end-state, MINUS app_defaults (already
                                   dropped by 015) and MINUS the notifications/
                                   push_subscriptions/notification_recipients
                                   tables (never a tracked migration; feature
                                   being removed)
    0002_rls.sql                 -- enable RLS on all 13 real tables in one
                                   pass (merges 006 + 016's still-relevant
                                   statements; drops references to tables that
                                   no longer exist in the baseline)
    0003_seed_accounts.sql       -- admin/director/quad/grade accounts, bare
                                   usernames, using the CURRENT correct grade
                                   convention (grade7g/grade7b — see CLAUDE.md
                                   "Email convention"), not migration 005's
                                   legacy grade7f/grade7m. must_change_password
                                   = true set inline at insert (folds in 017's
                                   intent for just these rows — no separate
                                   email-matching UPDATE pass needed).
                                   Password hashes unchanged (same bootstrap
                                   default password, still forced to change on
                                   first login).
    0004_drop_notification_tables.sql
                                  -- drop table if exists notification_recipients,
                                   notifications, push_subscriptions cascade;
                                   Idempotent no-op on a fresh org (never
                                   created there). Real cleanup on prod —
                                   GATED, see "Execution sequence" below.
  migrations_archive/
    001_initial_schema.sql … 020_user_leader_id.sql
                                  -- verbatim copies, historical record only,
                                   outside the Supabase CLI's scanned
                                   migrations folder (inert re: tooling)
```

New files use 4-digit numbering (`0001`+), deliberately distinct from the old
3-digit scheme, so there's no ambiguity about which era a filename belongs to.
The next real future migration (post-consolidation) becomes `0005`.

`docs/DEPLOYING.md` step 1.2 changes from "run every migration … in numeric
order" (20 files) to "run these 4 files in order." Wherever `CLAUDE.md` /
`README.md` cite an old migration number in prose (e.g. "migration `013`
fixed X"), add a short pointer that historical numbers now live in
`supabase/migrations_archive/` — the historical prose itself stays as written,
since it's still an accurate account of what happened when.

### 2. Seed username truncation

- `0003_seed_accounts.sql` (new): bare usernames throughout.
- `src/seed.ts` (in-memory dev/demo seed): truncate the same way; update the 5
  dependent test files (`access-control.test.ts`, `account.service.test.ts`,
  `auth.service.test.ts`, `leader-role.test.ts`, `multigrade-accounts.test.ts`
  — 22 occurrences total) to use the truncated usernames in their fixtures/
  assertions.
- `README.md` / `CLAUDE.md` seed-account tables: update the displayed
  usernames to match (currently show `admin@youth.ministry` etc.).
- Archived `002_seed_admin.sql` / `005_seed_users.sql` in
  `migrations_archive/`: left untouched — they're historical record of what
  actually ran against prod, not living code.

### 3. Verification (before touching prod)

Apply the old 001–020 and the new 0001–0004 to two throwaway Postgres schemas
(Supabase CLI local stack, or two temporary branches) and diff the resulting
DDL. Must match exactly, net of the intentional notifications-table exclusion
(confirm those 3 tables are the *only* diff).

### 4. Execution sequence against prod (gated, explicit steps)

1. Verify equivalence (above).
2. **Confirm the notifications-removal (other Claude instance) has shipped
   to production** before running `0004`'s DROP — do not run it against a
   database a live request might still touch. Ask the user to confirm if not
   independently verifiable.
3. Obtain prod access: user connects/authorizes the Supabase MCP integration
   for the citipointe-youth account (chosen over interactive CLI login).
4. Two distinct prod actions, run separately and shown to the user first:
   - Run `0004`'s DROP for real (destructive, one-way — final confirmation
     immediately before executing).
   - Run `supabase migration repair --status applied <0001..0004 versions>`
     (metadata-only: marks prod's tracked history as caught up without
     re-executing `0001`–`0003`'s `CREATE TABLE`s, which would otherwise fail
     with "already exists" since prod's schema already has them from the
     original 20).
5. Confirm afterward: `supabase migration list --linked` (or equivalent)
   shows a clean, matching history; app still functions normally (smoke
   check a login + a read endpoint).

## Out of scope

- Any changes to notification/push *application code* (owned by the other
  Claude instance).
- Any change to how future migrations are numbered beyond starting at `0005`.
- Rewriting historical prose in `CLAUDE.md` describing what old migration
  numbers did (only adding a pointer to the archive).
