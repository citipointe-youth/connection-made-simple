-- 015: Remove "Save Defaults" — it wrote a snapshot of users+leaders to
-- app_defaults, but nothing in the codebase ever read it back (no restore
-- path exists). Dead write-only functionality; safe to drop.

drop table if exists app_defaults;
