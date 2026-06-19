-- Push notifications feature — run this in the Supabase SQL editor (ap-southeast-2)

-- 1. Push subscriptions (one row per device per user)
create table if not exists push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      text not null references users(id) on delete cascade,
  endpoint     text not null,
  p256dh       text not null,
  auth         text not null,
  created_at   timestamptz not null default now(),
  unique (user_id, endpoint)
);
create index if not exists push_subscriptions_user_id_idx on push_subscriptions(user_id);

-- 2. Notification log (one row per send event)
create table if not exists notifications (
  id          uuid primary key default gen_random_uuid(),
  sender_id   text not null references users(id) on delete cascade,
  target      jsonb not null,
  title       text not null,
  message     text not null,
  sent        integer not null default 0,
  failed      integer not null default 0,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '3 days'),
  deleted_at  timestamptz
);
create index if not exists notifications_sender_id_idx on notifications(sender_id);
create index if not exists notifications_expires_at_idx on notifications(expires_at);

-- 3. Per-recipient rows (one row per user who received a notification)
create table if not exists notification_recipients (
  id               uuid primary key default gen_random_uuid(),
  notification_id  uuid not null references notifications(id) on delete cascade,
  recipient_id     text not null references users(id) on delete cascade,
  dismissed_at     timestamptz,
  unique (notification_id, recipient_id)
);
create index if not exists notification_recipients_recipient_idx on notification_recipients(recipient_id);
create index if not exists notification_recipients_notif_idx on notification_recipients(notification_id);
