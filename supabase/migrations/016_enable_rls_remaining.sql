-- Enable Row-Level Security on the four tables that migration 006 (and later
-- additions) missed: connection_audits, notifications, notification_recipients,
-- push_subscriptions. These were reachable via the Supabase anon key / PostgREST
-- until now — and they hold sensitive data (student attendance snapshots, personal
-- notification/contact data, push tokens), so closing that is defence-in-depth.
--
-- Same rationale as 006: the Express API connects via the postgres role (owner),
-- which bypasses RLS, so no policies are needed for the app. RLS enabled + no anon
-- policies = the anon/authenticated PostgREST roles are denied all rows.
--
-- (Applied directly on the production DB during the 2026-07 incident cleanup; this
-- migration keeps the repo in sync so a fresh provision reproduces it.)

alter table public.connection_audits       enable row level security;
alter table public.notifications           enable row level security;
alter table public.notification_recipients enable row level security;
alter table public.push_subscriptions      enable row level security;
