import postgres from 'postgres';
import { env } from '../../config/env';

export type SqlClient = ReturnType<typeof postgres>;

let _client: SqlClient | undefined;

export function getSqlClient(): SqlClient {
  if (!_client) {
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required when PERSISTENCE=supabase');
    _client = postgres(env.DATABASE_URL, {
      max: 1,
      prepare: false,
      idle_timeout: 10,    // close idle connections after 10s (prevents stale TCP in serverless)
      max_lifetime: 60,    // never keep a connection longer than 60s
      connect_timeout: 10, // fail fast if the DB doesn't respond within 10s
    });
  }
  return _client;
}
