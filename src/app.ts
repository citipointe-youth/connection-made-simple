import type { Express } from 'express';
import { buildContainer } from './container';
import { buildRoutes } from './api/http/router';
import { createApp } from './api/http/express-adapter';
import { seedDemoData } from './seed';
import { env } from './config/env';

export async function createAppInstance(): Promise<Express> {
  const container = await buildContainer();

  if (env.PERSISTENCE === 'memory') {
    await seedDemoData(container.repos);
  }

  const routes = buildRoutes(container.services);
  // No destroy-on-timeout hook. Force-destroying the shared client on a route
  // timeout (the incident-era escalation, commits bf395e5/ade64a6) killed the
  // in-flight queries of OTHER concurrent requests on the same warm instance —
  // live traces (2026-07-05) showed CONNECTION_DESTROYED failures at 5-10s across
  // unrelated endpoints, a new failure mode that didn't eliminate the 20s timeouts
  // it was meant to fix. The sister Camp Platform runs with none of this and is
  // stable. A genuinely stuck EXECUTING query is already bounded by the role-level
  // statement_timeout=15s (ALTER ROLE postgres SET statement_timeout, applied on the
  // prod DB), which frees the connection without destroying anyone else's work.
  const app = createApp(routes, container.services.auth);

  return app;
}
