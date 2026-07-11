-- Adds a per-account flag forcing a password change before any other route is
-- reachable (enforced in the app layer, not RLS — see MustChangePasswordError).
-- Default false: adding the column does NOT retroactively flag any existing row.
alter table users add column must_change_password boolean not null default false;

-- Flag the specific accounts originally seeded by 002_seed_admin.sql and
-- 005_seed_users.sql with a known, since-published default password. Matches by
-- email against both the original seed convention (grade7f/grade7m) and the
-- renamed convention documented in CLAUDE.md (grade7g/grade7b) — whichever is
-- actually live, since account emails are editable and may have been renamed
-- after seeding. Any email in this list that doesn't exist in `users` is simply
-- not matched; this is safe to run on a fresh install or this existing database.
update users set must_change_password = true
where email in (
  'admin@youth.ministry',
  'director@youth.ministry',
  'g79@youth.ministry', 'b79@youth.ministry',
  'g1012@youth.ministry', 'b1012@youth.ministry',
  'grade7f@youth.ministry', 'grade7m@youth.ministry',
  'grade7g@youth.ministry', 'grade7b@youth.ministry',
  'grade8f@youth.ministry', 'grade8m@youth.ministry',
  'grade8g@youth.ministry', 'grade8b@youth.ministry',
  'grade9f@youth.ministry', 'grade9m@youth.ministry',
  'grade9g@youth.ministry', 'grade9b@youth.ministry',
  'grade10f@youth.ministry', 'grade10m@youth.ministry',
  'grade10g@youth.ministry', 'grade10b@youth.ministry',
  'grade11f@youth.ministry', 'grade11m@youth.ministry',
  'grade11g@youth.ministry', 'grade11b@youth.ministry',
  'grade12f@youth.ministry', 'grade12m@youth.ministry',
  'grade12g@youth.ministry', 'grade12b@youth.ministry',
  'grade7@youth.ministry', 'grade8@youth.ministry', 'grade9@youth.ministry',
  'grade10@youth.ministry', 'grade11@youth.ministry', 'grade12@youth.ministry'
);
