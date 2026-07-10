function getEnv(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing required env var: ${key}`);
  return val;
}

const NODE_ENV = getEnv('NODE_ENV', 'development');

// In production, never silently fall back to a wildcard CORS origin. If
// CORS_ORIGINS is unset we fall back to APP_ORIGIN (each deployment's own
// domain), then to the original YS Brisbane URL so that existing deployment
// needs zero env changes. Dev keeps '*' for convenience.
const PROD_DEFAULT_ORIGIN = 'https://ys-connection.vercel.app';
const corsDefault = NODE_ENV === 'production' ? (process.env['APP_ORIGIN'] ?? PROD_DEFAULT_ORIGIN) : '*';

export const env = {
  PORT: parseInt(getEnv('PORT', '4300'), 10),
  NODE_ENV,
  PERSISTENCE: getEnv('PERSISTENCE', 'memory') as 'memory' | 'json' | 'supabase',
  DATA_DIR: getEnv('DATA_DIR', './data'),
  CORS_ORIGINS: getEnv('CORS_ORIGINS', corsDefault).split(','),
  APP_ORIGIN: process.env['APP_ORIGIN'],
  DATABASE_URL: process.env['DATABASE_URL'],
  VAPID_PUBLIC_KEY: process.env['VAPID_PUBLIC_KEY'] ?? '',
  VAPID_PRIVATE_KEY: process.env['VAPID_PRIVATE_KEY'] ?? '',
  VAPID_SUBJECT: process.env['VAPID_SUBJECT'] ?? '',
};
