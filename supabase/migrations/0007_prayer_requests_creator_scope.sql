-- A general (no-student) prayer now inherits a grade+gender "domain" from its
-- creator (access-control.ts's generalPrayerCreatorScope), so a grade/quad
-- account's general prayers stay within their own bracket instead of being
-- visible ministry-wide. Both null means no boundary (admin/director, or a
-- junior leader, who has none to derive).
alter table prayer_requests add column if not exists created_by_grades jsonb;
alter table prayer_requests add column if not exists created_by_gender text;
