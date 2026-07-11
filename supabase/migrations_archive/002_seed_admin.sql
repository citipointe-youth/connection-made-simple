-- Seeds the initial admin account.
-- BEFORE RUNNING: replace the password_hash placeholder with a real hash.
-- Generate it: create temp-hash.ts with the content in the CLAUDE.md bootstrap section, then run: npx tsx temp-hash.ts
-- The hash format is: salt:sha256(salt+password)  (NOT bcrypt)
-- This account is flagged must_change_password = true by migration 017, as
-- defense-in-depth in case the placeholder above was never actually replaced.
insert into users (display_name, email, role, status, password_hash)
values (
  'Admin',
  'admin@youth.ministry',
  'admin',
  'active',
  '7759d4a2e75601f277f0b150a13face8:81288b510e9570aad85a816dbd134a48535a6d93964916e3ecf685b718ff958a'
);
