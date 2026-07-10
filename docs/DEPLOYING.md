# Deploying YS Connection for your own ministry

This is the full path from an empty Supabase/Vercel account to a working,
branded deployment. It assumes you've cloned/forked this repo.

## 1. Create a Supabase project

1. Create a new project at [supabase.com](https://supabase.com) — pick the
   region closest to your users (the reference deployment uses Sydney,
   `ap-southeast-2`).
2. Run every migration in `supabase/migrations/`, **in numeric order**, via
   the Supabase SQL editor or the Supabase CLI (`supabase db push`). Each
   migration is additive (`add column if not exists …`) — there's no seed
   data to skip, but read `002_seed_admin.sql` / `005_seed_users.sql` before
   running them if you want a different starting account set than the
   YS Brisbane defaults (see step 6 below).
3. **Re-apply the role-level statement timeout — this is not in any migration:**
   ```sql
   alter role postgres set statement_timeout = '15s';
   ```
   This is a production DB config change, not code. Without it, a stuck query
   can hold a connection open indefinitely on Supabase's pooler and cascade
   into an outage under load (see `CLAUDE.md`'s incident history for the full
   story). If the database is ever recreated, re-apply this.

## 2. Create a Vercel project

1. Import the repo into Vercel.
2. Set these environment variables:

   | Variable | Value | Notes |
   |---|---|---|
   | `PERSISTENCE` | `supabase` | Production always uses Supabase, not in-memory. |
   | `DATABASE_URL` | `postgresql://postgres.<ref>:<password>@aws-1-<region>.pooler.supabase.com:5432/postgres` | **Must be the session-mode pooler on port `5432`, not the transaction-mode pooler on `6543`.** The transaction-mode pooler intermittently hands back dead connections under Vercel's serverless burst pattern — this caused a multi-day outage on the reference deployment. Get the exact connection string from Supabase → Project Settings → Database → Connection Pooling → Session mode. |
   | `SESSION_SECRET` | a random secret, e.g. `openssl rand -hex 32` | Required in production — without it, session tokens can be forged. |
   | `APP_ORIGIN` | `https://your-project.vercel.app` (or your custom domain) | Locks CORS to your own domain. Falls back to the original YS Brisbane URL if unset — **always set this** for a new deployment. |
   | `CORS_ORIGINS` | (usually unset) | Only set this if you need something other than `APP_ORIGIN` (e.g. multiple origins, comma-separated). |

3. Deploy.

## 3. First login and setup

1. Log in with one of the seeded accounts (see `README.md` for the list, or
   `002_seed_admin.sql`/`005_seed_users.sql` if you customised them).
2. Every seeded account is flagged `must_change_password` — you'll be forced
   to set your own password before anything else is reachable
   (migration `017_must_change_password.sql`). This exists because the seed
   migrations, and this repo's history, document a shared default password in
   a public repo — never leave a seeded password in place.
3. Go to **Admin → Settings → Youth Ministry Setup** and pick the preset
   closest to your ministry's shape (see `README.md`'s config section, or
   `../Generalisation of the app/02-youth-ministry-structures.md` if you have
   access to the generalisation design docs for the full archetype
   descriptions). Fine-tune branding/terminology/modules from there.

## Seed accounts by preset

- **Large graded ministry (AU)** (the default): the full grade+quad account
  set from `002_seed_admin.sql`/`005_seed_users.sql` works as-is.
- **Two-bracket / Small flat / Micro**: the grade/quad seed accounts won't
  match your structure. Simplest path: log in as the seeded `admin` account,
  delete the accounts you don't need from Admin → Accounts, and create the
  ones you do (Youth Pastor / Senior Leader / Junior Leader roles under the
  flat preset — the Junior Leader role is added by a later phase of the
  generalisation work; if it's not yet in your checkout, senior/junior
  leaders temporarily share the Senior Leader (`director`) scope).

## Icons and PWA identity

- `public/icons/*.png` (the app icon at various sizes) and
  `public/icons/icon.svg` are static files — replace them in your fork with
  your own ministry's icon. There's no runtime icon configuration.
- Everything else PWA-related (app name, short name, theme colour) comes from
  `GET /manifest.json`, which reads live from your Youth Ministry Setup
  branding config — no file to edit for that part.

## Rollback

If something goes wrong, Vercel's dashboard → Deployments → "Instant
Rollback" to any previous deployment is non-destructive and doesn't touch the
database (migrations are additive, so older code runs fine against a newer
schema). See `../Generalisation of the app/09-rollback.md` if you have access
to that doc, for the specific rollback point this generalisation work was
built from.
