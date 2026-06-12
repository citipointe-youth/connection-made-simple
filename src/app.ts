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
  const app = createApp(routes, container.services.auth);

  return app;
}
