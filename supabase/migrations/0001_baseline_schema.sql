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
