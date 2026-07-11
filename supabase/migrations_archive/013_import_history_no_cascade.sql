-- 013: Clearing import history must NOT delete attendance data.
--
-- service_sessions.import_id and lifegroup_weeks.import_id were declared
-- ON DELETE CASCADE against import_records, so deleting an import-history row
-- (the Import screen's "Clear All" and per-row trash) cascaded through to the
-- sessions/weeks and their attendance, wiping the live data.
--
-- Switch both FKs to ON DELETE SET NULL (and drop the NOT NULL on the columns)
-- so clearing history removes only the log entry and leaves the attendance
-- intact. Wiping actual attendance data stays the job of admin → Clear
-- Service/Group data (admin.service.clearServiceGroupData), which deletes the
-- sessions/weeks/attendance directly. import_id is only provenance here
-- (imports are full-replace; deleteByImport is unused), so nulling it is safe.

alter table service_sessions alter column import_id drop not null;
alter table service_sessions drop constraint service_sessions_import_id_fkey;
alter table service_sessions
  add constraint service_sessions_import_id_fkey
  foreign key (import_id) references import_records(id) on delete set null;

alter table lifegroup_weeks alter column import_id drop not null;
alter table lifegroup_weeks drop constraint lifegroup_weeks_import_id_fkey;
alter table lifegroup_weeks
  add constraint lifegroup_weeks_import_id_fkey
  foreign key (import_id) references import_records(id) on delete set null;
