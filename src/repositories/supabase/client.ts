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
    // Pool size per serverless instance. Restored to 5 (from the incident-era max:2)
    // to match the sister Youth Camp Platform, which runs max:5 on the same free-tier
    // Supavisor pool at comparable scale with no timeout machinery and no contention
    // problems. max:2 was too small for CMS's per-page fan-out: live [db-dispatch]
    // traces (2026-07-05) showed a request's own queries dispatching 15-19s late
    // because only 2 could be in-flight per instance while the rest queued —
    // head-of-line blocking that then tripped the 20s route timeout. A warm instance
    // multiplexes concurrent requests, so 2 connections choke a Home/Trends load that
    // fans out 5-9 requests each issuing several queries; 5 gives them room. The
    // transaction pooler multiplexes, and warm-instance reuse (not one cold Lambda per
    // user) keeps real simultaneous backend connections well under the 60 ceiling.
    max: 5,
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
    // DIAGNOSTIC (2026-07-05, active 503/timeout incident — see plannedupdate.md):
    // `debug` fires only once a query has been handed to a physical connection and is
    // about to go out on the wire — i.e. AFTER any wait for a free pool slot / new
    // connection. Comparing this timestamp against the request-start log in
    // express-adapter.ts tells us whether a slow request stalled acquiring a
    // connection (big gap here) or executing/transferring the query (small gap here,
    // long gap before the route's own "done" log). Never logs `parameters` — those
    // are bound query values (names, phone numbers) and must not hit logs.
    debug: (connectionId, query) => {
      const store = requestContext.getStore();
      const tag = store ? `${store.id} ${store.route} +${Date.now() - store.start}ms` : 'no-request-ctx';
      console.log(`[db-dispatch] conn=${connectionId} ${tag} :: ${query.slice(0, 80)}`);
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

// getSqlClient() returns this SAME object forever — container.ts (and every
// repository it constructs) captures it exactly once and holds onto it for the
// life of the warm serverless instance (api/index.ts caches the whole app/container
// per instance). That reference can never be swapped out from outside, so a naive
// "replace the client" fix (tried and reverted 2026-07-05, see plannedupdate.md)
// never reaches the repos that already captured the old one. Instead, every call
// through this stable proxy re-resolves getRealClient() at the moment it's used, so
// destroySqlClient() can swap what's underneath without any repo needing to know.
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

// query.cancel() only hard-aborts a query that's the one actively being processed
// right now on its connection; one still queued behind another query on the same
// connection (pipelined, `max: 2` means this is common) just gets soft-marked and
// keeps waiting its turn regardless (confirmed live: a query re-dispatched ~79s
// after we'd already cancelled it). Destroying the real connection and swapping in
// a fresh one (transparently, via getRealClient() above) is the only way to stop a
// request from being able to sit behind whatever stalled that connection in the
// first place — without this, an earlier attempt that replaced the module-level
// client outright caused every subsequent query on the same warm instance to fail
// instantly, because repos never call getSqlClient() again after construction.
export async function destroySqlClient(): Promise<void> {
  const real = _realClient;
  _realClient = undefined;
  if (!real) return;
  try {
    await real.end({ timeout: 0 });
  } catch {
    // best-effort teardown of a connection we already know is unhealthy
  }
}
