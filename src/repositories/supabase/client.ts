import postgres from 'postgres';
import { env } from '../../config/env';
import { requestContext, type CancellableQuery } from '../../utils/request-context';

export type SqlClient = ReturnType<typeof postgres>;

// Coerce a DB timestamp column to an ISO string without ever throwing. The porsager
// driver normally returns a Date for timestamptz, but a null/string/number (or a
// row mangled by a transient pooler hiccup) used to blow up `(x as Date).toISOString()`
// with a TypeError -> 500. For a real Date this is identical to the old cast.
export function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return new Date(v).toISOString();
  return new Date().toISOString();
}

// The actual, swappable postgres.js connection. Only accessed through getRealClient()
// below so a stuck connection can be torn down and replaced without anyone needing
// to know it happened.
let _realClient: SqlClient | undefined;

function createRealClient(): SqlClient {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required when PERSISTENCE=supabase');
  return postgres(env.DATABASE_URL, {
    // Pool size per serverless instance. Kept SMALL on purpose. The binding limit on
    // the free tier is Supavisor's CLIENT-connection cap (EMAXCONN, limit 200), and
    // under a concurrent burst Vercel spins up many serverless instances at once — so
    // total pooler connections = (instances) x (max). A load test (2026-07-05) at
    // ~10-30 simultaneous Home loads hit `(EMAXCONN) max client connections reached,
    // limit: 200` and failed fast; raising max from 2->5 made it hit the ceiling
    // sooner, not later. Every extra connection per instance is multiplied across
    // every warm instance, so this stays low. The real fix for the target concurrency
    // is architectural (fewer requests per page / fewer queries per request), not a
    // bigger pool — see the incident notes in CLAUDE.md.
    max: 2,
    prepare: false,
    // idle_timeout/max_lifetime were tuned low (30s/60s) specifically to recycle
    // connections quickly, but that means even a warm, actively-used Lambda
    // instance is forced to tear down and re-establish a DB connection (fresh
    // TCP+TLS to the pooler) almost every request — Postgres logs show new
    // connection authorizations every 15-30s all session long. Each of those
    // re-establishments is a chance to hit the free-tier pool's occasional slow
    // handshake. Raised both so a warm instance reuses its connections across many
    // more requests instead of constantly reconnecting; still well within a
    // typical Lambda's warm lifetime, so a going-cold instance still cleans up.
    idle_timeout: 120,
    max_lifetime: 300,
    connect_timeout: 10, // fail fast if the DB doesn't respond (cold starts can be slow)
    connection: {
      statement_timeout: 15000,  // kill any query running > 15s (prevents indefinite hangs)
    },
  });
}

function getRealClient(): SqlClient {
  if (!_realClient) _realClient = createRealClient();
  return _realClient;
}

// Registers every query this request issues with requestContext so a route that
// times out (withTimeout, utils/timeout.ts) can call .cancel() on whatever's still
// running instead of abandoning it on a pooled connection. postgres.js's tagged
// Query is itself a thenable (extends Promise), so attaching .then() here doesn't
// change its result or re-run it — it only lets us drop the entry once it settles.
function trackForCancellation(query: unknown): void {
  const store = requestContext.getStore();
  if (store && query && typeof (query as { cancel?: unknown }).cancel === 'function' && typeof (query as { then?: unknown }).then === 'function') {
    const cancellable = query as CancellableQuery;
    store.pendingQueries.add(cancellable);
    const untrack = () => store.pendingQueries.delete(cancellable);
    (query as Promise<unknown>).then(untrack, untrack);
  }
}

// getSqlClient() returns a stable proxy that container.ts (and every repository it
// builds) captures exactly once for the life of the warm serverless instance. The
// proxy registers every query it dispatches with the request context
// (trackForCancellation) so a route that hits its timeout can cancel its own
// still-running queries, without threading the request id through every repository.
let _stableClient: SqlClient | undefined;

export function getSqlClient(): SqlClient {
  if (!_stableClient) {
    _stableClient = new Proxy(function sqlClientProxyTarget() { /* replaced via apply trap */ } as unknown as SqlClient, {
      apply(_target, thisArg, args) {
        const real = getRealClient();
        const query: unknown = Reflect.apply(real as unknown as (...a: unknown[]) => unknown, thisArg, args);
        trackForCancellation(query);
        return query;
      },
      get(_target, prop, _receiver) {
        const real = getRealClient();
        const value = (real as unknown as Record<PropertyKey, unknown>)[prop];
        return typeof value === 'function' ? value.bind(real) : value;
      },
    }) as SqlClient;
  }
  return _stableClient;
}
