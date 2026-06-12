-- Seeds the initial admin account.
-- BEFORE RUNNING: replace the password_hash placeholder with a real hash.
-- Generate it: create temp-hash.ts with the content in the CLAUDE.md bootstrap section, then run: npx tsx temp-hash.ts
-- The hash format is: salt:sha256(salt+password)  (NOT bcrypt)
insert into users (display_name, email, role, status, password_hash)
values (
  'Admin',
  'admin@youth.ministry',
  'admin',
  'active',
  'PLACEHOLDER_REPLACE_BEFORE_USE'
);
