-- Enforce a single-row settings table by switching to a fixed text primary key.
-- Without this, concurrent cold-start requests can each insert their own
-- settings row because gen_random_uuid() never conflicts on the PK.

-- Cast id from uuid → text (uuid strings cast cleanly; existing rows keep their values).
alter table app_settings alter column id drop default;
alter table app_settings alter column id type text using id::text;
alter table app_settings alter column id set default 'global';

-- Consolidate any existing rows: promote the first row to id='global',
-- then delete extras. Safe to run multiple times.
do $$
begin
  if exists(select 1 from app_settings where id = 'global') then
    delete from app_settings where id <> 'global';
  elsif exists(select 1 from app_settings) then
    update app_settings set id = 'global'
      where id = (select id from app_settings order by updated_at desc limit 1);
    delete from app_settings where id <> 'global';
  end if;
end $$;
