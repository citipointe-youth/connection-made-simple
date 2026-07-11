-- Connection Audit snapshots: one self-contained, frozen audit per calendar
-- year. `snapshot` holds the per-term aggregates + CRM upload overlays computed
-- at upload time, so a past year stays viewable even after the live platform's
-- two-term window has rolled past it.
create table if not exists connection_audits (
  id          text primary key,          -- the year as text, e.g. '2026'
  year        int  not null unique,
  label       text not null,
  uploaded_by text not null,
  uploaded_at timestamptz not null,
  snapshot    jsonb not null
);
