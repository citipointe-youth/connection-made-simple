import express, { type Express, type Request, type Response } from 'express';
import { env } from '../../config/env';
import type { Route, HttpRequest } from './types';
import type { AuthService } from '../../services/auth.service';
import { resolveContext } from '../middleware/auth.middleware';
import { sendError } from '../middleware/error.middleware';
import { UnauthorizedError } from '../../core/errors/app-error';
import { createLogger } from '../../utils/logger';
import { RateLimiter } from '../../utils/rate-limiter';

const logger = createLogger('http');

// 10 attempts per IP per 15 minutes
const loginRateLimiter = new RateLimiter(10, 15 * 60 * 1000);

export function createApp(routes: Route[], authService: AuthService): Express {
  const app = express();

  if (env.NODE_ENV === 'production' && env.CORS_ORIGINS.includes('*')) {
    logger.warn('CORS_ORIGINS is set to * in production — lock it to your domain for security');
  }

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  app.use((req, res, next) => {
    const origin = req.headers['origin'];
    if (!origin || env.CORS_ORIGINS.includes(origin) || env.CORS_ORIGINS.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', origin ?? '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', ts: new Date().toISOString() });
  });

  app.use(express.static('public'));

  app.set('trust proxy', 1);

  for (const route of routes) {
    const method = route.method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete';
    app[method](route.path, async (req: Request, res: Response) => {
      try {
        // Rate-limit login attempts by IP
        if (route.path === '/auth/login' && route.method === 'POST') {
          const ip = req.ip ?? req.headers['x-forwarded-for']?.toString() ?? 'unknown';
          if (loginRateLimiter.isBlocked(ip)) {
            res.status(429).setHeader('Retry-After', String(loginRateLimiter.retryAfterSeconds(ip)));
            res.json({ code: 'RATE_LIMITED', message: 'Too many login attempts. Try again later.' });
            return;
          }
        }

        const ctx = await resolveContext(req.headers['authorization'], authService, route.auth);
        if (route.auth && !ctx) throw new UnauthorizedError();

        const httpReq: HttpRequest = {
          ctx,
          params: req.params as Record<string, string>,
          query: req.query as Record<string, string | undefined>,
          body: req.body,
        };

        const result = await route.handler(httpReq);
        res.json(result);
      } catch (err) {
        sendError(res, err);
      }
    });
  }

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Endpoint not found' });
  });

  return app;
}
