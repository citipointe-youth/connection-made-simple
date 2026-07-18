-- A prayer request can now be "general" — not tied to a specific student
-- (someone outside the app, or a whole-group request). Scope resolves through
-- the student when present; a null student_id has no scope and is visible to
-- everyone with prayer:read (enforced in prayer.service.ts, not here).
alter table prayer_requests alter column student_id drop not null;
