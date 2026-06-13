-- Enable Row-Level Security on all tables.
--
-- The Express API connects via the postgres superuser (DATABASE_URL), which
-- bypasses RLS automatically — no policies are needed for the app.
--
-- With RLS enabled and no anon policies defined, any connection using the
-- Supabase anon key (PostgREST / client SDK) is denied access to all rows,
-- providing defence-in-depth if the anon key ever leaked.

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
alter table app_defaults           enable row level security;
alter table admin_audit            enable row level security;
