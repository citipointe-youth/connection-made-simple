# Migration Consolidation + Seed Username Truncation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 20 sequential Supabase SQL migrations with a small consolidated set for new-church deployments (archiving the originals for history), truncate all seed-account login identities from fake emails to bare usernames, and drop the orphaned notifications tables from production — all without disturbing the live system's current schema or tracked migration history until an explicit, gated final step.

**Architecture:** `supabase/migrations/` goes from 20 files to 4 (`0001_baseline_schema.sql`, `0002_rls.sql`, `0003_seed_accounts.sql`, `0004_drop_notification_tables.sql`); the original `001`–`020` files move verbatim to `supabase/migrations_archive/` (outside the Supabase CLI's scanned folder — inert for tooling, kept for history). `0004` is a one-off cleanup migration: after it's run against prod, it also gets archived, leaving 3 permanent files. Application-layer seed data (`src/seed.ts`) and its dependent tests get the same username truncation. Prod is touched only in the final, explicitly gated task.

**Tech Stack:** Supabase Postgres, Supabase CLI 2.102.0, TypeScript/Express/vitest, Supabase MCP tools (`mcp__claude_ai_Supabase__*`).

## Global Constraints

- **Must not change prod's live schema or data**, except the explicitly gated Task 13 DROP — every other task only touches repo files.
- Migrations must work whether applied via `supabase db push` (CLI, tracked) or pasted manually into the Supabase SQL editor (no CLI tracking) — no CLI-only syntax in the SQL files themselves.
- All new SQL uses the same idempotent style as the originals (`create table if not exists`, `create index if not exists`, `drop table if exists`) wherever the original migrations did.
- `npm run typecheck` and `npm run test` (`vitest run`) must both pass after every code/test-touching task.
- Do not touch `docs/push_subscriptions.sql` or any notification *application code* — that is owned by a separate, concurrent Claude instance. This plan only touches the database side (dropping the now-orphaned tables) and `supabase/migrations/`.
- Task 13 (prod execution) requires explicit human confirmation before each destructive action, even though the user has pre-approved the overall approach — show the exact command/diff and pause.

---

### Task 1: Archive the original 20 migrations

**Files:**
- Create: `supabase/migrations_archive/` (new directory)
- Move: `supabase/migrations/001_initial_schema.sql` … `supabase/migrations/020_user_leader_id.sql` (all 20 files) → `supabase/migrations_archive/`

**Interfaces:**
- Produces: `supabase/migrations_archive/` containing all 20 original files, byte-identical, for Task 12's schema-equivalence check and for historical reference. `supabase/migrations/` temporarily empty (populated by Tasks 2–5).

- [ ] **Step 1: Create the archive directory and move the files**

```bash
cd "C:\Users\thoma\Claude Programs\Project 7 - Connection Made Simple\connection-made-simple"
mkdir -p supabase/migrations_archive
git mv supabase/migrations/001_initial_schema.sql supabase/migrations_archive/
git mv supabase/migrations/002_seed_admin.sql supabase/migrations_archive/
git mv supabase/migrations/003_settings_singleton.sql supabase/migrations_archive/
git mv supabase/migrations/004_fix_valid_threshold.sql supabase/migrations_archive/
git mv supabase/migrations/005_seed_users.sql supabase/migrations_archive/
git mv supabase/migrations/006_enable_rls.sql supabase/migrations_archive/
git mv supabase/migrations/007_perf_indexes_and_threshold.sql supabase/migrations_archive/
git mv supabase/migrations/008_service_min_attendance.sql supabase/migrations_archive/
git mv supabase/migrations/009_connection_audits.sql supabase/migrations_archive/
git mv supabase/migrations/010_remove_unused_settings.sql supabase/migrations_archive/
git mv supabase/migrations/011_import_id_indexes.sql supabase/migrations_archive/
git mv supabase/migrations/012_saturday_week_buckets.sql supabase/migrations_archive/
git mv supabase/migrations/013_import_history_no_cascade.sql supabase/migrations_archive/
git mv supabase/migrations/014_leaders_sms_template.sql supabase/migrations_archive/
git mv supabase/migrations/015_drop_app_defaults.sql supabase/migrations_archive/
git mv supabase/migrations/016_enable_rls_remaining.sql supabase/migrations_archive/
git mv supabase/migrations/017_must_change_password.sql supabase/migrations_archive/
git mv supabase/migrations/018_ministry_config.sql supabase/migrations_archive/
git mv supabase/migrations/019_user_grades_gender.sql supabase/migrations_archive/
git mv supabase/migrations/020_user_leader_id.sql supabase/migrations_archive/
```

- [ ] **Step 2: Verify the move**

Run: `ls supabase/migrations/ && echo --- && ls supabase/migrations_archive/ | wc -l`
Expected: `supabase/migrations/` prints nothing (empty); the archive count is `20`.

- [ ] **Step 3: Commit**

```bash
git add -A supabase/migrations supabase/migrations_archive
git commit -m "Archive original 20 Supabase migrations ahead of consolidation"
```

---

### Task 2: Write the consolidated baseline schema

**Files:**
- Create: `supabase/migrations/0001_baseline_schema.sql`

**Interfaces:**
- Consumes: nothing (first migration in the new chain).
- Produces: all 13 real tables + 6 indexes at their final (post-migration-020) shape, matching prod's current live schema exactly except it never creates `app_defaults` (dropped by archived migration `015`) or `notifications`/`push_subscriptions`/`notification_recipients` (never a tracked migration — see Task 5).

- [ ] **Step 1: Write the file**

```sql
-- Consolidated baseline schema for a fresh deployment (supersedes the
-- archived 001-020 migrations in supabase/migrations_archive/). Represents
-- the cumulative schema those 20 migrations produce, minus app_defaults
-- (dropped by archived migration 015) and minus the notifications/
-- push_subscriptions/notification_recipients tables (never a tracked
-- migration — see supabase/migrations_archive/016_enable_rls_remaining.sql's
-- comment; the notifications feature is being retired).

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  email text unique not null,
  role text not null,
  grade int,
  quad text,
  status text not null default 'active',
  password_hash text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  must_change_password boolean not null default false,
  grades jsonb,
  gender text,
  leader_id text
);

create table if not exists students (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  gender text not null,
  grade int,
  quad text,
  mobile text,
  parent_phone text,
  date_of_birth date,
  svc_attended int not null default 0,
  svc_total int not null default 0,
  grp_attended int not null default 0,
  grp_total int not null default 0,
  grp_met_weeks int not null default 0,
  prev_svc_attended int not null default 0,
  prev_svc_total int not null default 0,
  prev_grp_attended int not null default 0,
  prev_grp_total int not null default 0,
  at_risk_status text,
  data_source text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists leaders (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  gender text,
  grades int[] not null default '{}',
  active boolean not null default true,
  created_by_grade int,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  sms_template text
);

create table if not exists connections (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references students(id) on delete cascade,
  leader_id uuid not null references leaders(id) on delete cascade,
  assigned_by_role text not null,
  created_at timestamptz default now(),
  unique(student_id, leader_id)
);

create table if not exists import_records (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  filename text not null,
  file_hash text not null,
  row_count int not null default 0,
  sessions_added int not null default 0,
  students_added int not null default 0,
  students_updated int not null default 0,
  status text not null default 'ok',
  error_message text,
  imported_at timestamptz default now(),
  imported_by text not null
);

-- import_id is nullable with ON DELETE SET NULL from the start here (the
-- archived migration 013 had to ALTER this after the fact because it was
-- originally NOT NULL + CASCADE; a fresh deployment gets the fixed shape
-- immediately — clearing import history must never cascade-delete attendance).
create table if not exists service_sessions (
  id uuid primary key default gen_random_uuid(),
  import_id uuid references import_records(id) on delete set null,
  session_date date not null,
  session_name text not null,
  is_regular boolean not null default true,
  is_valid boolean not null default true,
  total_attendance int not null default 0,
  sort_order int not null default 0,
  created_at timestamptz default now()
);

create table if not exists service_attendance (
  student_id uuid not null references students(id) on delete cascade,
  session_id uuid not null references service_sessions(id) on delete cascade,
  attended boolean not null,
  primary key (student_id, session_id)
);

create table if not exists lifegroups (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  short_name text not null,
  grade int,
  gender text,
  created_at timestamptz default now()
);

create table if not exists lifegroup_weeks (
  id uuid primary key default gen_random_uuid(),
  import_id uuid references import_records(id) on delete set null,
  week_num int not null,
  week_key text not null,
  week_start date not null,
  week_end date
);

create table if not exists lifegroup_attendance (
  student_id uuid not null references students(id) on delete cascade,
  week_id uuid not null references lifegroup_weeks(id) on delete cascade,
  lifegroup_id uuid not null references lifegroups(id) on delete cascade,
  group_met boolean not null,
  attended boolean not null,
  primary key (student_id, week_id)
);

-- Singleton settings row, keyed directly by a fixed text id (the archived
-- migration 003 had to fix this after the fact from a uuid PK that let
-- concurrent cold-starts insert duplicate rows; a fresh deployment gets the
-- fixed shape immediately). Column set is the final one after archived
-- migrations 004/007/008/010/018 (ministry_name/service_name/lifegroup_name/
-- connection_lock_date/reg_rate_*/risk_rate_* were added then dropped by 010
-- and are omitted here entirely).
create table if not exists app_settings (
  id text primary key default 'global',
  term_gap_days int not null default 14,
  valid_threshold_pct int not null default 25,
  service_min_attendance int not null default 100,
  ministry_config jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);

create table if not exists admin_audit (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  performed_by text not null,
  performed_at timestamptz default now(),
  detail text not null
);

create table if not exists connection_audits (
  id          text primary key,
  year        int  not null unique,
  label       text not null,
  uploaded_by text not null,
  uploaded_at timestamptz not null,
  snapshot    jsonb not null
);

-- Indexes (from archived migrations 007 + 011).
create index if not exists idx_connections_leader_id on connections (leader_id);
create index if not exists idx_service_attendance_session_id on service_attendance (session_id);
create index if not exists idx_lifegroup_attendance_lifegroup_id on lifegroup_attendance (lifegroup_id);
create index if not exists idx_lifegroup_attendance_week_id on lifegroup_attendance (week_id);
create index if not exists idx_service_sessions_import_id on public.service_sessions (import_id);
create index if not exists idx_lifegroup_weeks_import_id  on public.lifegroup_weeks  (import_id);
```

- [ ] **Step 2: Verify it's valid, self-contained SQL**

Run: `Get-Content "supabase/migrations/0001_baseline_schema.sql" | Measure-Object -Line` (or `wc -l` in Bash) and eyeball that all 13 `create table` statements and 6 `create index` statements are present.
Expected: file exists, no syntax placeholders, matches the 13 tables/6 indexes listed above (full automated verification happens in Task 12).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0001_baseline_schema.sql
git commit -m "Add consolidated baseline schema migration (0001)"
```

---

### Task 3: Write the consolidated RLS migration

**Files:**
- Create: `supabase/migrations/0002_rls.sql`

**Interfaces:**
- Consumes: the 13 tables created by Task 2's `0001_baseline_schema.sql`.
- Produces: RLS enabled on all 13 real tables (merges archived migrations `006` + `016`, dropping the 4 statements `016` had for tables not created here).

- [ ] **Step 1: Write the file**

```sql
-- Enable Row-Level Security on every table.
--
-- The Express API connects via the postgres superuser (DATABASE_URL), which
-- bypasses RLS automatically — no policies are needed for the app. With RLS
-- enabled and no anon policies defined, any connection using the Supabase
-- anon key (PostgREST / client SDK) is denied access to all rows, providing
-- defence-in-depth if the anon key ever leaked. (Consolidates archived
-- migrations 006 + 016.)

alter table users                  enable row level security;
alter table students               enable row level security;
alter table leaders                enable row level security;
alter table connections            enable row level security;
alter table import_records         enable row level security;
alter table service_sessions       enable row level security;
alter table service_attendance     enable row level security;
alter table lifegroups             enable row level security;
alter table lifegroup_weeks        enable row level security;
alter table lifegroup_attendance   enable row level security;
alter table app_settings           enable row level security;
alter table admin_audit            enable row level security;
alter table connection_audits      enable row level security;
```

- [ ] **Step 2: Verify**

Run: `Get-Content "supabase/migrations/0002_rls.sql"` and confirm all 13 table names match Task 2's `create table` list exactly (no typos, no extra/missing tables).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0002_rls.sql
git commit -m "Add consolidated RLS migration (0002)"
```

---

### Task 4: Write the consolidated seed-accounts migration (bare usernames)

**Files:**
- Create: `supabase/migrations/0003_seed_accounts.sql`

**Interfaces:**
- Consumes: the `users` table from Task 2.
- Produces: 18 seeded accounts (admin, director, 4 quads, 12 grade×gender logins), all with bare-username `email` values and `must_change_password = true` set inline. Password hashes are reused verbatim from archived `002_seed_admin.sql`/`005_seed_users.sql` — same bootstrap default password, same forced-change-on-first-login behavior.

- [ ] **Step 1: Write the file**

```sql
-- Seeds the ministry user accounts with a shared default (bootstrap-only)
-- password. Consolidates archived migrations 002 + 005 + the relevant part
-- of 017 (must_change_password is now set inline here instead of a separate
-- email-matching UPDATE pass over both legacy naming conventions).
--
-- Login identities are bare usernames, not fake emails (the app already
-- treats this field as a free-form username everywhere — see CLAUDE.md's
-- "Username convention" section). Grade accounts use the CURRENT g(irls)/
-- b(oys) suffix convention directly (archived migration 005 originally used
-- f/m, later renamed) — there is no legacy f/m seed in a fresh deployment.
--
-- ON CONFLICT DO NOTHING: safe to re-run, never overwrites a changed password.
-- Do not restore a plaintext default password to this comment.
insert into users (display_name, email, role, grade, quad, status, password_hash, must_change_password)
values
  ('Admin',           'admin',     'admin',    null, null,    'active', '7759d4a2e75601f277f0b150a13face8:81288b510e9570aad85a816dbd134a48535a6d93964916e3ecf685b718ff958a', true),
  ('Director',        'director',  'director', null, null,    'active', '200d0ad2d4ed33b88089ecc8e632a813:4eb81e4e10713463c50fd123f7f3078edbe7a33536618a3b04b8c6634cd0a443', true),
  ('Girls Yr 7-9',    'g79',       'quad',     null, 'g79',   'active', 'f9baba7871f5e1b5893c61abffc7396b:17ea274458ed50db10e9379f1b1e275b7afeb2ac4aa4e373be4fecf915f7384b', true),
  ('Boys Yr 7-9',     'b79',       'quad',     null, 'b79',   'active', '71ae68769705f02c5951911760c83fa5:7617679f623efbb04b014f4a8941e8ba555ca358a873224a74fa4e1e37485627', true),
  ('Girls Yr 10-12',  'g1012',     'quad',     null, 'g1012', 'active', '30dca6e09b33ac6a8a88b48dbd0a634c:dcd6ecae81f0373c938cfcd245e30b9bf8b1def6f0b2e92db01b86c6242cdca5', true),
  ('Boys Yr 10-12',   'b1012',     'quad',     null, 'b1012', 'active', '2792547bd7060b9ae19cdac56822a008:fd28beceff2bb002c66cf788fd34e5eb24f4ec9f17b046a5158055c6d5c4d875', true),
  ('Grade 7 Girls',   'grade7g',   'grade',    7,    null,    'active', '43111ad633d059b70fa96871441cbd35:fce97c662d659c3576d3320095066596342af19db3dd6297ff8cfc43ccc9fe0c', true),
  ('Grade 7 Boys',    'grade7b',   'grade',    7,    null,    'active', '0e78d8f1d63e30a34a0890ddce904073:abf64f7420261e2bbf6b38b7df73955b7d06820e2d61062402386498d85f12b2', true),
  ('Grade 8 Girls',   'grade8g',   'grade',    8,    null,    'active', '620258b70a0c0ea7168510e8aec6e000:8fe0626d9d1ade5a40bdd2608c475747b2dd2056908f88b8b108f928337ba617', true),
  ('Grade 8 Boys',    'grade8b',   'grade',    8,    null,    'active', '5c11846a9e318bdbd1204545d9bb6a37:0468e5dc5f0f5fd0ff19e0ba1a4900615b75a5f4eef85084d717d9e16cb124b1', true),
  ('Grade 9 Girls',   'grade9g',   'grade',    9,    null,    'active', '1fb875304832f0c0e1d119fee2e23be2:5cb771d40352d14b5b92c44ca08d6d385b9d72d31802dd52c628a894caff1e9b', true),
  ('Grade 9 Boys',    'grade9b',   'grade',    9,    null,    'active', 'd6c84e8531ef77c1015a6f3b06f3d8ed:f1c305b33e7225b1cc7f360c75c86809287a53af92150ab9a358affc9579eb8c', true),
  ('Grade 10 Girls',  'grade10g',  'grade',    10,   null,    'active', 'd8a2b028bdd74149f2b62ecf76cf7a5b:c8e3b768203cf85417f174fc69e8447e5e6da8e0eb053a201062ad22f1663ebc', true),
  ('Grade 10 Boys',   'grade10b',  'grade',    10,   null,    'active', '6db16dec0dfe389f0de7c0bfd72b38d0:4f2f4fb13ba867ac4416f78d7b83e9cb1f0d028bef70dd9cb297c14b60440cc2', true),
  ('Grade 11 Girls',  'grade11g',  'grade',    11,   null,    'active', 'f67f7614d10a81f3e50aa1a4d5d1c18a:ee96290cb7b90db0fafcd82b330f90a5ed2ccf9ce38205ccae470c8a69525a68', true),
  ('Grade 11 Boys',   'grade11b',  'grade',    11,   null,    'active', '90d85f42c4c74de5642f078b689b670e:29d33af8e50a45d3a87c576d2260012a6a3f0aa2019ae95dc9b6bc71897b4b7f', true),
  ('Grade 12 Girls',  'grade12g',  'grade',    12,   null,    'active', '69674658b88ff310301b76dfa8b0efa2:d8e7fdaf66d1c2285f7a1b3daa20b3e2c2fa76ec80d7baa4c12ae48a10b0b9e7', true),
  ('Grade 12 Boys',   'grade12b',  'grade',    12,   null,    'active', 'a0b88a7bd1acc523d901778a375232c9:de331842d8570f777ce40ecba067a2b36ae39849888225de1d9ae529f76af88b', true)
on conflict (email) do nothing;
```

- [ ] **Step 2: Verify**

Run: `Get-Content "supabase/migrations/0003_seed_accounts.sql"` and confirm: 18 data rows, every `email` value has no `@` character, every row has `true` in the last (`must_change_password`) column, and the 12 grade rows use `g`/`b` suffixes (not `f`/`m`).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0003_seed_accounts.sql
git commit -m "Add consolidated seed-accounts migration with bare usernames (0003)"
```

---

### Task 5: Write the one-off notifications-tables cleanup migration

**Files:**
- Create: `supabase/migrations/0004_drop_notification_tables.sql`

**Interfaces:**
- Consumes: nothing from Tasks 2–4 (the tables it drops were never created by them).
- Produces: a migration that is a no-op on any fresh deployment (these tables don't exist there) and, when run against prod in Task 13, actually removes the orphaned tables. Gets moved to `supabase/migrations_archive/` after that run (Task 13, Step 5) — it is not meant to be a permanent file.

- [ ] **Step 1: Write the file**

```sql
-- One-off cleanup: notification_recipients / notifications / push_subscriptions
-- were created ad hoc via docs/push_subscriptions.sql (NEVER a tracked
-- migration — following supabase/migrations_archive/016_enable_rls_remaining.sql's
-- RLS-enable statements on a truly fresh project would otherwise fail with
-- "relation does not exist", since nothing ever created these tables there).
-- The notifications feature's application code is being retired, so these
-- tables become dead weight. Idempotent no-op on a fresh deployment (never
-- created there); on prod this genuinely drops the orphaned tables and their
-- data. Run once against prod, then move this file to
-- supabase/migrations_archive/ — it has no further purpose after that.
drop table if exists notification_recipients cascade;
drop table if exists notifications cascade;
drop table if exists push_subscriptions cascade;
```

- [ ] **Step 2: Verify**

Run: `Get-Content "supabase/migrations/0004_drop_notification_tables.sql"` and confirm the drop order (recipients before notifications, matching the FK direction) and `cascade` on all three.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0004_drop_notification_tables.sql
git commit -m "Add one-off migration to drop orphaned notification tables (0004)"
```

---

### Task 6: Verify schema equivalence (old chain vs new chain)

**Files:**
- Create (scratch, not committed): two temp working copies under the session scratchpad, e.g. `C:\Users\thoma\AppData\Local\Temp\claude\...\scratchpad\verify-old\` and `...\verify-new\`

**Interfaces:**
- Consumes: `supabase/migrations_archive/001…020` (old chain) and `supabase/migrations/0001…0003` (new chain — deliberately excludes `0004`, since that's prod-only cleanup with nothing to compare against on a fresh DB).
- Produces: a written confirmation (pasted into the task's commit message or a scratch note) that both chains produce identical schemas, net of the notifications-table exclusion.

- [ ] **Step 1: Confirm Docker is available**

Run: `docker ps`
Expected: a running container list (possibly empty), not a connection error. If it errors (`cannot connect to the Docker API`), start Docker Desktop and wait for it to report healthy, then retry. If Docker genuinely isn't available in this environment, skip to Step 5 (manual checklist) instead of Steps 2-4.

- [ ] **Step 2: Build schema A from the archived (old) migration chain**

```bash
SCRATCH="C:\Users\thoma\AppData\Local\Temp\claude\C--Users-thoma\5775a974-1aad-401a-b0aa-e423afedc340\scratchpad"
rm -rf "$SCRATCH/verify-old" && mkdir -p "$SCRATCH/verify-old/supabase/migrations"
cp supabase/migrations_archive/*.sql "$SCRATCH/verify-old/supabase/migrations/"
cd "$SCRATCH/verify-old" && supabase init --workdir . -y 2>&1 || true
supabase start --workdir .
supabase db dump --local --workdir . -s public > "$SCRATCH/schema-old.sql"
supabase stop --workdir .
```

Expected: `schema-old.sql` is written and non-empty (`wc -l "$SCRATCH/schema-old.sql"` > 0).

- [ ] **Step 3: Build schema B from the new consolidated chain (0001-0003 only)**

```bash
cd "C:\Users\thoma\Claude Programs\Project 7 - Connection Made Simple\connection-made-simple"
rm -rf "$SCRATCH/verify-new" && mkdir -p "$SCRATCH/verify-new/supabase/migrations"
cp supabase/migrations/0001_baseline_schema.sql supabase/migrations/0002_rls.sql supabase/migrations/0003_seed_accounts.sql "$SCRATCH/verify-new/supabase/migrations/"
cd "$SCRATCH/verify-new" && supabase init --workdir . -y 2>&1 || true
supabase start --workdir .
supabase db dump --local --workdir . -s public > "$SCRATCH/schema-new.sql"
supabase stop --workdir .
```

Expected: `schema-new.sql` is written and non-empty.

- [ ] **Step 4: Diff the two schema dumps**

```bash
diff "$SCRATCH/schema-old.sql" "$SCRATCH/schema-new.sql"
```

Expected: the only differences are (a) `app_defaults` present in `schema-old.sql` but absent from `schema-new.sql` — **wrong**, `app_defaults` should be absent from BOTH since archived migration `015` drops it; if it appears in `schema-old.sql` that means the archived chain reproduced correctly (015 ran) — investigate if it's missing from neither or present in `schema-new.sql`; and (b) `notifications`/`push_subscriptions`/`notification_recipients` present in neither (they were never a tracked migration in either chain — this is expected and fine, it's the seed-data gap this whole plan is aware of). If any *other* table, column, index, or constraint differs, stop and reconcile Task 2/3/4's SQL against the archived migrations before proceeding.

- [ ] **Step 5 (fallback if Docker unavailable): manual column checklist**

Cross-check `supabase/migrations/0001_baseline_schema.sql` table-by-table against the archived migrations' cumulative effect:

| Table | Archived migrations contributing | Confirmed in 0001? |
|---|---|---|
| `users` | 001, 017 (`must_change_password`), 019 (`grades`,`gender`), 020 (`leader_id`) | ☐ |
| `students` | 001 only | ☐ |
| `leaders` | 001, 014 (`sms_template`) | ☐ |
| `connections` | 001 only | ☐ |
| `import_records` | 001 only | ☐ |
| `service_sessions` | 001, 013 (`import_id` nullable + `on delete set null`) | ☐ |
| `service_attendance` | 001 only | ☐ |
| `lifegroups` | 001 only | ☐ |
| `lifegroup_weeks` | 001, 013 (`import_id` nullable + `on delete set null`) | ☐ |
| `lifegroup_attendance` | 001 only | ☐ |
| `app_settings` | 001, 003 (`id` → text `'global'`), 004+007 (`valid_threshold_pct` default churn, final=25), 008 (`service_min_attendance`), 010 (drops `ministry_name`/`service_name`/`lifegroup_name`/`connection_lock_date`/`reg_rate_*`/`risk_rate_*`), 018 (`ministry_config`) | ☐ |
| `admin_audit` | 001 only | ☐ |
| `connection_audits` | 009 only | ☐ |
| `app_defaults` | 001, dropped by 015 — **must NOT appear in 0001** | ☐ |
| Indexes | 007 (4 indexes), 011 (2 indexes) — 6 total | ☐ |

Tick every row after re-reading the corresponding archived file(s) and confirming Task 2's SQL matches.

- [ ] **Step 6: Record the result**

No file changes in this task (verification only) — note the outcome (Docker diff clean, or manual checklist fully ticked) in the PR/commit description for Task 12, so the evidence is preserved.

---

### Task 7: Update `docs/DEPLOYING.md`

**Files:**
- Modify: `docs/DEPLOYING.md`

**Interfaces:**
- Consumes: the new file names from Tasks 2-4.
- Produces: deployment instructions that match the new 3-file reality (4th file `0004` is prod-only cleanup, not part of the new-deployment story — omit it from these instructions entirely).

- [ ] **Step 1: Replace the migration-running step**

Old text (`docs/DEPLOYING.md` lines 11-16):
```
2. Run every migration in `supabase/migrations/`, **in numeric order**, via
   the Supabase SQL editor or the Supabase CLI (`supabase db push`). Each
   migration is additive (`add column if not exists …`) — there's no seed
   data to skip, but read `002_seed_admin.sql` / `005_seed_users.sql` before
   running them if you want a different starting account set than the
   YS Brisbane defaults (see step 6 below).
```

New text:
```
2. Run the 3 migrations in `supabase/migrations/`, **in numeric order**
   (`0001_baseline_schema.sql`, `0002_rls.sql`, `0003_seed_accounts.sql`), via
   the Supabase SQL editor or the Supabase CLI (`supabase db push`). (A 20-file
   history of how this schema evolved lives in `supabase/migrations_archive/`,
   kept for reference only — you don't need to run those.) There's no seed
   data to skip, but read `0003_seed_accounts.sql` before running it if you
   want a different starting account set than the YS Brisbane defaults (see
   step 6 below). Seed logins are bare usernames (e.g. `admin`, `grade7g`),
   not real email addresses.
```

- [ ] **Step 2: Update the first-login step's file reference**

Old text (`docs/DEPLOYING.md` line 44):
```
1. Log in with one of the seeded accounts (see `README.md` for the list, or
   `002_seed_admin.sql`/`005_seed_users.sql` if you customised them).
```

New text:
```
1. Log in with one of the seeded accounts (see `README.md` for the list, or
   `0003_seed_accounts.sql` if you customised them).
```

- [ ] **Step 3: Verify**

Run: `Select-String -Path "docs/DEPLOYING.md" -Pattern "002_seed|005_seed|017_must|numeric order"` (PowerShell) and confirm no remaining references to the old filenames.

- [ ] **Step 4: Commit**

```bash
git add docs/DEPLOYING.md
git commit -m "Update DEPLOYING.md for consolidated 3-file migration set"
```

---

### Task 8: Update `README.md` seed-account table

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the truncated usernames this plan is standardizing on.
- Produces: a seed-account table matching what `src/seed.ts` (Task 10) will actually insert.

- [ ] **Step 1: Replace the table**

Old text (`README.md` lines 28-33):
```
| Email | Role |
|-------|------|
| `admin@youth.ministry` | admin |
| `director@youth.ministry` | director |
| `g79@youth.ministry` / `b79@youth.ministry` / `g1012@youth.ministry` / `b1012@youth.ministry` | quad |
| `grade7@youth.ministry` … `grade12@youth.ministry` | grade |
```

New text:
```
| Username | Role |
|-------|------|
| `admin` | admin |
| `director` | director |
| `g79` / `b79` / `g1012` / `b1012` | quad |
| `grade7` … `grade12` | grade |
```

- [ ] **Step 2: Verify**

Run: `Select-String -Path "README.md" -Pattern "@youth.ministry"` (PowerShell) — expect no matches.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Update README seed-account table to bare usernames"
```

---

### Task 9: Update `CLAUDE.md` seed-account docs

**Files:**
- Modify: `C:\Users\thoma\Claude Programs\Project 7 - Connection Made Simple\connection-made-simple\CLAUDE.md`

**Interfaces:**
- Consumes: the truncated usernames from Task 4/10 and the new migration filenames from Tasks 2-5.
- Produces: the "Seed demo accounts" section (lines 187-211) describing the current, post-consolidation reality.

- [ ] **Step 1: Replace the whole section**

Old text (`CLAUDE.md` lines 187-211):
```
## Seed demo accounts

| Email | Role | Scope |
|-------|------|-------|
| `admin@youth.ministry` | admin | All |
| `director@youth.ministry` | director | All |
| `g79@youth.ministry` | quad | Girls Yr 7–9 |
| `b79@youth.ministry` | quad | Boys Yr 7–9 |
| `g1012@youth.ministry` | quad | Girls Yr 10–12 |
| `b1012@youth.ministry` | quad | Boys Yr 10–12 |
| `grade7@youth.ministry` … `grade12@youth.ministry` | grade | one per grade (the in-code seed has one account per grade) |

Local `PERSISTENCE=memory` dev/demo mode: password `demo1234` for all of the above,
same as before. **Supabase/production accounts are different:** every account
inserted by `002_seed_admin.sql` / `005_seed_users.sql` (and any account matching
one of the emails above, post-rename) is flagged `must_change_password = true` by
migration `017_must_change_password.sql` — the account holder must set their own
password via `POST /accounts/me/password` (or the forced first-login screen) before
anything else is reachable. See "Forced password change" under Security notes.

**Email convention:** grade logins use **`g` (girls) / `b` (boys)** suffixes —
e.g. `grade7g@youth.ministry`, `grade7b@youth.ministry` (NOT `…f` / `…m`). Account
emails are **editable** in admin → Accounts → Edit (`account.service.update` accepts
`email` with a uniqueness check), so the actual logins can be renamed to this scheme.
```

New text:
```
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
`must_change_password = true` — the account holder must set their own password via
`POST /accounts/me/password` (or the forced first-login screen) before anything
else is reachable. See "Forced password change" under Security notes.

**Username convention:** grade logins use **`g` (girls) / `b` (boys)** suffixes —
e.g. `grade7g`, `grade7b` (NOT `…f` / `…m`, an earlier naming scheme). Account
usernames are **editable** in admin → Accounts → Edit (`account.service.update`
accepts `email` with a uniqueness check — the field is internally still called
`email` but is a free-form login handle, not a real email address).
```

- [ ] **Step 2: Verify**

Run: `Select-String -Path "CLAUDE.md" -Pattern "@youth.ministry"` (PowerShell) — expect matches ONLY inside the two archived-filename references just added (`002_seed_admin.sql`/`005_seed_users.sql`/`017_must_change_password.sql` sentence), not in any table row or the convention example. Manually re-read the diff to confirm.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "Update CLAUDE.md seed-account docs for consolidated migrations + bare usernames"
```

---

### Task 10: Truncate `src/seed.ts` usernames

**Files:**
- Modify: `src/seed.ts:15-76`

**Interfaces:**
- Consumes: nothing new.
- Produces: in-memory (`PERSISTENCE=memory`) dev/demo seed data using bare usernames, matching Task 8's README table.

- [ ] **Step 1: Replace the `users` array**

Old string (`src/seed.ts:15-76`, the full `const users: User[] = [...]` block):
```typescript
  const users: User[] = [
    {
      id: generateId(), displayName: 'Admin', email: 'admin@youth.ministry',
      role: 'admin', grade: null, quad: null,
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Director', email: 'director@youth.ministry',
      role: 'director', grade: null, quad: null,
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Girls Yr 7–9 Quad', email: 'g79@youth.ministry',
      role: 'quad', grade: null, quad: 'g79',
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Boys Yr 7–9 Quad', email: 'b79@youth.ministry',
      role: 'quad', grade: null, quad: 'b79',
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Girls Yr 10–12 Quad', email: 'g1012@youth.ministry',
      role: 'quad', grade: null, quad: 'g1012',
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Boys Yr 10–12 Quad', email: 'b1012@youth.ministry',
      role: 'quad', grade: null, quad: 'b1012',
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Grade 7', email: 'grade7@youth.ministry',
      role: 'grade', grade: 7, quad: null,
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Grade 8', email: 'grade8@youth.ministry',
      role: 'grade', grade: 8, quad: null,
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Grade 9', email: 'grade9@youth.ministry',
      role: 'grade', grade: 9, quad: null,
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Grade 10', email: 'grade10@youth.ministry',
      role: 'grade', grade: 10, quad: null,
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Grade 11', email: 'grade11@youth.ministry',
      role: 'grade', grade: 11, quad: null,
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Grade 12', email: 'grade12@youth.ministry',
      role: 'grade', grade: 12, quad: null,
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
  ];
```

New string:
```typescript
  const users: User[] = [
    {
      id: generateId(), displayName: 'Admin', email: 'admin',
      role: 'admin', grade: null, quad: null,
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Director', email: 'director',
      role: 'director', grade: null, quad: null,
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Girls Yr 7–9 Quad', email: 'g79',
      role: 'quad', grade: null, quad: 'g79',
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Boys Yr 7–9 Quad', email: 'b79',
      role: 'quad', grade: null, quad: 'b79',
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Girls Yr 10–12 Quad', email: 'g1012',
      role: 'quad', grade: null, quad: 'g1012',
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Boys Yr 10–12 Quad', email: 'b1012',
      role: 'quad', grade: null, quad: 'b1012',
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Grade 7', email: 'grade7',
      role: 'grade', grade: 7, quad: null,
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Grade 8', email: 'grade8',
      role: 'grade', grade: 8, quad: null,
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Grade 9', email: 'grade9',
      role: 'grade', grade: 9, quad: null,
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Grade 10', email: 'grade10',
      role: 'grade', grade: 10, quad: null,
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Grade 11', email: 'grade11',
      role: 'grade', grade: 11, quad: null,
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Grade 12', email: 'grade12',
      role: 'grade', grade: 12, quad: null,
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
  ];
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors (this is a pure string-literal change, `User.email` is typed `string`).

- [ ] **Step 3: Commit**

```bash
git add src/seed.ts
git commit -m "Truncate in-memory dev/demo seed usernames"
```

---

### Task 11: Truncate the 5 dependent test files

**Files:**
- Modify: `src/tests/account.service.test.ts:17,72`
- Modify: `src/tests/auth.service.test.ts:11,21,28`
- Modify: `src/tests/access-control.test.ts:56-60`
- Modify: `src/tests/leader-role.test.ts:125,131`
- Modify: `src/tests/multigrade-accounts.test.ts:52,60,61,82,95,107,117,126,137,150`

**Interfaces:**
- Consumes: nothing new — these are self-contained unit tests with inline fixtures (confirmed none of the 5 files import or call `seedDemoData`).
- Produces: passing tests using bare-username fixtures. `deriveActorGender` (`src/services/auth.service.ts:14-27`) already splits defensively on `@` (`(user.email || '').split('@')[0]`), so a string with no `@` at all is handled identically to today — confirmed safe, no source change needed.

- [ ] **Step 1: `src/tests/account.service.test.ts` — 2 edits**

Old: `    id: 'u-grade', displayName: 'Grade Leader', email: 'grade7g@youth.ministry', role: 'grade',`
New: `    id: 'u-grade', displayName: 'Grade Leader', email: 'grade7g', role: 'grade',`

Old: `      displayName: 'New Leader', email: 'newleader@youth.ministry', password: 'longenoughpw',`
New: `      displayName: 'New Leader', email: 'newleader', password: 'longenoughpw',`

- [ ] **Step 2: `src/tests/auth.service.test.ts` — 2 edits (one is `replace_all` since the login line appears twice, identically)**

Old: `    id: 'u-1', displayName: 'Director', email: 'director@youth.ministry', role: 'director',`
New: `    id: 'u-1', displayName: 'Director', email: 'director', role: 'director',`

Old (appears twice, lines 21 and 28 — use `replace_all: true`, both get the same transform): `    const { token } = await auth.login({ email: 'director@youth.ministry', password: 'correcthorse1' });`
New: `    const { token } = await auth.login({ email: 'director', password: 'correcthorse1' });`

- [ ] **Step 3: `src/tests/access-control.test.ts` — 5 edits (one block, each line individually unique)**

Old: `    expect(deriveActorGender(mk('grade', 'grade7g@youth.ministry'))).toBe('female');`
New: `    expect(deriveActorGender(mk('grade', 'grade7g'))).toBe('female');`

Old: `    expect(deriveActorGender(mk('grade', 'grade7b@youth.ministry'))).toBe('male');`
New: `    expect(deriveActorGender(mk('grade', 'grade7b'))).toBe('male');`

Old: `    expect(deriveActorGender(mk('grade', 'grade7@youth.ministry'))).toBeNull(); // no suffix`
New: `    expect(deriveActorGender(mk('grade', 'grade7'))).toBeNull(); // no suffix`

Old: `    expect(deriveActorGender(mk('quad', 'b1012@youth.ministry', 'b1012'))).toBe('male');`
New: `    expect(deriveActorGender(mk('quad', 'b1012', 'b1012'))).toBe('male');`

Old: `    expect(deriveActorGender(mk('admin', 'admin@youth.ministry'))).toBeNull();`
New: `    expect(deriveActorGender(mk('admin', 'admin'))).toBeNull();`

- [ ] **Step 4: `src/tests/leader-role.test.ts` — 2 edits (each line individually unique — one has `leaderId: LEADER_ID,` trailing, the other doesn't)**

Old: `      displayName: 'JL', email: 'jl@youth.ministry', password: 'longenoughpw', role: 'leader',`
New: `      displayName: 'JL', email: 'jl', password: 'longenoughpw', role: 'leader',`

Old: `      displayName: 'JL', email: 'jl@youth.ministry', password: 'longenoughpw', role: 'leader', leaderId: LEADER_ID,`
New: `      displayName: 'JL', email: 'jl', password: 'longenoughpw', role: 'leader', leaderId: LEADER_ID,`

- [ ] **Step 5: `src/tests/multigrade-accounts.test.ts` — 10 edits (each line individually unique)**

Old: `    id: 'u', displayName: 'X', email: 'grade789@youth.ministry', role: 'grade',`
New: `    id: 'u', displayName: 'X', email: 'grade789', role: 'grade',`

Old: `    expect(deriveActorGender(mk({ email: 'grade7g@youth.ministry', grade: 7 }))).toBe('female');`
New: `    expect(deriveActorGender(mk({ email: 'grade7g', grade: 7 }))).toBe('female');`

Old: `    expect(deriveActorGender(mk({ email: 'grade7@youth.ministry', grade: 7 }))).toBeNull();`
New: `    expect(deriveActorGender(mk({ email: 'grade7', grade: 7 }))).toBeNull();`

Old: `      displayName: 'Junior Girls', email: 'juniorg@youth.ministry', password: 'longenoughpw',`
New: `      displayName: 'Junior Girls', email: 'juniorg', password: 'longenoughpw',`

Old: `      displayName: 'Grade 8', email: 'grade8@youth.ministry', password: 'longenoughpw',`
New: `      displayName: 'Grade 8', email: 'grade8', password: 'longenoughpw',`

Old: `        displayName: 'Bad', email: 'bad@youth.ministry', password: 'longenoughpw',`
New: `        displayName: 'Bad', email: 'bad', password: 'longenoughpw',`

Old: `        displayName: 'No Gender', email: 'nogender@youth.ministry', password: 'longenoughpw',`
New: `        displayName: 'No Gender', email: 'nogender', password: 'longenoughpw',`

Old: `      displayName: 'Grade 9', email: 'grade9x@youth.ministry', password: 'longenoughpw',`
New: `      displayName: 'Grade 9', email: 'grade9x', password: 'longenoughpw',`

Old: `      displayName: 'Grade 7', email: 'grade7@youth.ministry', password: 'longenoughpw',`
New: `      displayName: 'Grade 7', email: 'grade7', password: 'longenoughpw',`

Old: `      displayName: 'Messy', email: 'messy@youth.ministry', password: 'longenoughpw',`
New: `      displayName: 'Messy', email: 'messy', password: 'longenoughpw',`

- [ ] **Step 6: Run the affected tests specifically**

Run: `npm run test -- account.service auth.service access-control leader-role multigrade-accounts`
Expected: all pass, including every `deriveActorGender` assertion in `access-control.test.ts` and `multigrade-accounts.test.ts` — this is the concrete check that the `@`-splitting logic in `src/services/auth.service.ts:21` really is domain-agnostic, not just a theoretical read of the source.

- [ ] **Step 7: Run the full suite**

Run: `npm run test`
Expected: all tests pass (186+ tests, per CLAUDE.md's current count).

- [ ] **Step 8: Commit**

```bash
git add src/tests/account.service.test.ts src/tests/auth.service.test.ts src/tests/access-control.test.ts src/tests/leader-role.test.ts src/tests/multigrade-accounts.test.ts
git commit -m "Truncate @youth.ministry test fixtures to bare usernames"
```

---

### Task 12: Final full-repo check

**Files:** none (verification only)

**Interfaces:**
- Consumes: everything from Tasks 1-11.
- Produces: confidence the whole consolidation is internally consistent before touching prod.

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `npm run test`
Expected: all pass.

- [ ] **Step 3: Confirm no stray `@youth.ministry` references remain outside the archive**

Run: `Select-String -Path "supabase\migrations\*.sql","src\**\*.ts","README.md","CLAUDE.md","docs\DEPLOYING.md" -Pattern "@youth.ministry"` (PowerShell, recurse `src` if needed)
Expected: zero matches (the archived files under `supabase/migrations_archive/` are excluded from this check on purpose — they're historical record and untouched, per the spec).

- [ ] **Step 4: Confirm `supabase/migrations/` has exactly 4 files, `supabase/migrations_archive/` has exactly 20**

Run: `(ls supabase/migrations/*.sql).Count` and `(ls supabase/migrations_archive/*.sql).Count` (PowerShell)
Expected: `4` and `20`.

- [ ] **Step 5: Commit (if anything was fixed in Steps 1-4)**

Only if fixes were needed:
```bash
git add -A
git commit -m "Fix issues found in final consolidation check"
```

---

### Task 13: GATED — execute against production (do not run without explicit human go-ahead at each sub-step)

**Files:**
- Move: `supabase/migrations/0004_drop_notification_tables.sql` → `supabase/migrations_archive/0004_drop_notification_tables.sql` (after it's actually been run against prod)

**Interfaces:**
- Consumes: everything from Tasks 1-12, plus live access to the Supabase project `ltcblcudlzlzfcyzlhpc` (citipointe-youth org) via the `mcp__claude_ai_Supabase__*` tools.
- Produces: prod's tracked migration history reconciled with the new file set, and the orphaned notification tables actually dropped.

**This task must not be executed automatically as part of a task-by-task run.** Each sub-step below requires a fresh, explicit confirmation from the user, shown the exact command/diff first — per this plan's Global Constraints and the design spec's execution sequence.

- [ ] **Step 1: Confirm the concurrent notifications-removal has shipped**

Ask the user (or independently verify via the deployed app/Vercel) that the separate Claude instance's removal of notification application code is deployed to production. Do not proceed to Step 4 (the DROP) until this is confirmed — a live request touching `notifications`/`push_subscriptions`/`notification_recipients` mid-drop would error.

- [ ] **Step 2: Connect the Supabase MCP integration**

Ask the user to connect/authorize the citipointe-youth Supabase account for this session's `mcp__claude_ai_Supabase__*` tools (it currently shows zero connected projects). Verify with:

```
mcp__claude_ai_Supabase__list_projects
```

Expected: the citipointe-youth project (ref `ltcblcudlzlzfcyzlhpc`) appears in the result.

- [ ] **Step 3: Inspect prod's current tracked migration history**

```
mcp__claude_ai_Supabase__list_migrations(project_id: "ltcblcudlzlzfcyzlhpc")
```

Record the exact version strings shown for the 20 already-applied migrations — this confirms the version-token format (e.g. `001` vs a zero-padded/timestamp form) so Step 6's repair command uses matching syntax.

- [ ] **Step 4: Run the DROP for real — show the exact SQL and get explicit confirmation first**

Show the user the contents of `supabase/migrations/0004_drop_notification_tables.sql` (from Task 5) verbatim and get explicit go-ahead immediately before running. Then execute it against prod (via `mcp__claude_ai_Supabase__apply_migration` or `execute_sql` — whichever the connected tool set exposes) with that exact SQL:

```sql
drop table if exists notification_recipients cascade;
drop table if exists notifications cascade;
drop table if exists push_subscriptions cascade;
```

Verify afterward: `mcp__claude_ai_Supabase__list_tables(project_id: "ltcblcudlzlzfcyzlhpc", schemas: ["public"], verbose: false)` — expect `notification_recipients`, `notifications`, `push_subscriptions` absent from the result.

- [ ] **Step 5: Archive `0004` locally**

```bash
cd "C:\Users\thoma\Claude Programs\Project 7 - Connection Made Simple\connection-made-simple"
git mv supabase/migrations/0004_drop_notification_tables.sql supabase/migrations_archive/0004_drop_notification_tables.sql
```

- [ ] **Step 6: Reconcile prod's tracked migration history — metadata-only, get explicit confirmation first**

This step does NOT re-run any SQL — it only tells prod's `supabase_migrations.schema_migrations` table "these versions are already applied," matching Step 3's recorded version format. Show the user the exact command before running:

```bash
supabase link --project-ref ltcblcudlzlzfcyzlhpc
supabase migration repair --status applied 0001 0002 0003 0004
```

(Adjust the version tokens `0001 0002 0003 0004` to match whatever format Step 3 revealed prod actually uses, if it differs from the bare filename prefix.)

Verify: `supabase migration list --linked` shows a clean, fully-applied history with no pending/missing entries.

- [ ] **Step 7: Smoke-check the live app**

Log in to https://ys-connection.vercel.app with one existing (already-renamed, not from this plan's new seed) production account and confirm a basic read (e.g. Home screen loads) still works — confirms the DROP + repair didn't disturb anything the running app depends on.

- [ ] **Step 8: Final commit**

```bash
git add -A
git commit -m "Archive one-off notification-tables-drop migration after running against prod"
```

---

## Self-review notes

- **Spec coverage:** every section of `docs/superpowers/specs/2026-07-11-migration-consolidation-design.md` maps to a task — consolidation (Tasks 1-6), DEPLOYING.md/README/CLAUDE.md docs (Tasks 7-9), seed truncation in both migrations (Task 4) and `src/seed.ts` + tests (Tasks 10-11), verification (Task 6, Task 12), gated prod execution incl. the DROP (Task 13).
- **`deriveActorGender` risk (flagged by the test-fixture research agent):** resolved by reading `src/services/auth.service.ts:21` directly — it does `(user.email || '').split('@')[0]`, which is a no-op when there's no `@` at all. No source change needed; Task 11 Step 6 runs the specific tests as live confirmation rather than relying on this read alone.
- **Count corrections applied:** the plan uses the subagent-confirmed exact occurrence counts (`account.service.test.ts`: 2, `access-control.test.ts`: 5, `multigrade-accounts.test.ts`: 10), not the earlier grep estimates.
- **`auth.service.test.ts` non-unique line:** flagged and handled explicitly in Task 11 Step 2 (`replace_all: true`).
