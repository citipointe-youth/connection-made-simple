import { requestContext } from './request-context';

// Safety net for requests that hang past the point of being useful — e.g. a stalled
// pooler connection that never surfaces a Postgres-level error (statement_timeout only
// fires once a query is actually executing; it doesn't cover a hang acquiring a
// connection in the first place). Without this, a stuck request silently rides all
// the way to the platform's hard function timeout (60s) as an opaque runtime error
// instead of a fast, retryable one.
export class RequestTimeoutError extends Error {
  constructor(ms: number) {
    super(`Request timed out after ${ms}ms`);
    this.name = 'RequestTimeoutError';
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Just rejecting here used to leave the route's DB queries running: with only
      // `max: 2` connections per serverless instance, an abandoned-but-still-running
      // query kept a connection tied up indefinitely, and any later request that
      // landed on that same connection queued up behind it (observed live: a query
      // dispatched but not actually sent for ~5s, and a driver-level "Unknown Message"
      // protocol desync) — turning one slow request into a pile-up across unrelated
      // endpoints. Cancelling sends a real Postgres cancel request and frees the
      // connection instead of abandoning it.
      for (const q of requestContext.getStore()?.pendingQueries ?? []) q.cancel();
      reject(new RequestTimeoutError(ms));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
