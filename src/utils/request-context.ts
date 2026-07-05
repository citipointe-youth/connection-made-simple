import { AsyncLocalStorage } from 'node:async_hooks';

export interface CancellableQuery {
  cancel(): void;
}

export interface RequestContext {
  id: string;
  route: string;
  start: number;
  // Every DB query dispatched during this request, so a route that times out can
  // cancel its own still-running queries instead of abandoning them on a pooled
  // connection (see withTimeout in utils/timeout.ts + the sql proxy in
  // repositories/supabase/client.ts). Removed as each query settles.
  pendingQueries: Set<CancellableQuery>;
}

// Lets code far from the HTTP layer (the DB client) tag its own logs/queries with
// the request that triggered them, without threading an id through every function
// signature. Read via getStore().
export const requestContext = new AsyncLocalStorage<RequestContext>();
