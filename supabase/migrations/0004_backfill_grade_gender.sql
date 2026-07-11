-- Bug 2 (admin bug list, 2026-07-11): the seed grade accounts (grade7g/
-- grade7b … grade12g/grade12b, migration 0003) never set the explicit
-- `gender` column — deriveActorGender() falls back to reading it off the
-- g/b username suffix, which works for login scoping, but leaves the
-- Accounts edit form's "Gender scope" dropdown showing "Select gender…"
-- instead of the account's actual scope, and (more importantly) breaks the
-- "was this account's name still the auto-generated default" check the
-- grade-change auto-rename now relies on (see suggestEmail()/
-- _acctSuggestedGradeEmail() in public/index.html).
--
-- Backfill only — never overwrites a gender an admin has already set
-- in the Accounts screen (`where gender is null`), and only touches the
-- exact seeded g/b username pattern so a differently-named grade account
-- is left untouched.
update users
set gender = 'female'
where role = 'grade' and gender is null and email ~ '^grade[0-9]+g$';

update users
set gender = 'male'
where role = 'grade' and gender is null and email ~ '^grade[0-9]+b$';
