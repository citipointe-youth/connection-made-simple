create table users (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  email text unique not null,
  role text not null,
  grade int,
  quad text,
  status text not null default 'active',
  password_hash text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table students (
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

create table leaders (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  gender text,
  grades int[] not null default '{}',
  active boolean not null default true,
  created_by_grade int,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table connections (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references students(id) on delete cascade,
  leader_id uuid not null references leaders(id) on delete cascade,
  assigned_by_role text not null,
  created_at timestamptz default now(),
  unique(student_id, leader_id)
);

create table import_records (
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

create table service_sessions (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references import_records(id) on delete cascade,
  session_date date not null,
  session_name text not null,
  is_regular boolean not null default true,
  is_valid boolean not null default true,
  total_attendance int not null default 0,
  sort_order int not null default 0,
  created_at timestamptz default now()
);

create table service_attendance (
  student_id uuid not null references students(id) on delete cascade,
  session_id uuid not null references service_sessions(id) on delete cascade,
  attended boolean not null,
  primary key (student_id, session_id)
);

create table lifegroups (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  short_name text not null,
  grade int,
  gender text,
  created_at timestamptz default now()
);

create table lifegroup_weeks (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references import_records(id) on delete cascade,
  week_num int not null,
  week_key text not null,
  week_start date not null,
  week_end date
);

create table lifegroup_attendance (
  student_id uuid not null references students(id) on delete cascade,
  week_id uuid not null references lifegroup_weeks(id) on delete cascade,
  lifegroup_id uuid not null references lifegroups(id) on delete cascade,
  group_met boolean not null,
  attended boolean not null,
  primary key (student_id, week_id)
);

create table app_settings (
  id uuid primary key default gen_random_uuid(),
  ministry_name text not null default 'Youth Ministry',
  term_gap_days int not null default 14,
  reg_rate_numerator int not null default 1,
  reg_rate_denominator int not null default 2,
  risk_rate_numerator int not null default 1,
  risk_rate_denominator int not null default 3,
  valid_threshold_pct int not null default 10,
  service_name text not null default 'Service',
  lifegroup_name text not null default 'Lifegroup',
  connection_lock_date date,
  updated_at timestamptz default now()
);

create table app_defaults (
  id uuid primary key default gen_random_uuid(),
  snapshot jsonb not null,
  created_at timestamptz default now()
);

create table admin_audit (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  performed_by text not null,
  performed_at timestamptz default now(),
  detail text not null
);
