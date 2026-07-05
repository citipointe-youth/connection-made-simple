import type { Express } from 'express';
import { buildContainer } from './container';
import { buildRoutes } from './api/http/router';
import { createApp } from './api/http/express-adapter';
import { seedDemoData } from './seed';
import { env } from './config/env';
import { destroySqlClient } from './repositories/supabase/client';

export async function createAppInstance(): Promise<Express> {
  const container = await buildContainer();

  if (env.PERSISTENCE === 'memory') {
    await seedDemoData(container.repos);
  }

  const routes = buildRoutes(container.services);
  // Only Supabase has a pooled connection worth force-closing on a route timeout —
  // see destroySqlClient's own comment for why a soft query-cancel isn't enough.
  const onRouteTimeout = env.PERSISTENCE === 'supabase' ? () => { void destroySqlClient(); } : undefined;
  const app = createApp(routes, container.services.auth, onRouteTimeout);

  return app;
}
