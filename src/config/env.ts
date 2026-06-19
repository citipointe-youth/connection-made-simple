function getEnv(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const env = {
  PORT: parseInt(getEnv('PORT', '4300'), 10),
  NODE_ENV: getEnv('NODE_ENV', 'development'),
  PERSISTENCE: getEnv('PERSISTENCE', 'memory') as 'memory' | 'json' | 'supabase',
  DATA_DIR: getEnv('DATA_DIR', './data'),
  CORS_ORIGINS: getEnv('CORS_ORIGINS', '*').split(','),
  DATABASE_URL: process.env['DATABASE_URL'],
  VAPID_PUBLIC_KEY: process.env['VAPID_PUBLIC_KEY'] ?? '',
  VAPID_PRIVATE_KEY: process.env['VAPID_PRIVATE_KEY'] ?? '',
  VAPID_SUBJECT: process.env['VAPID_SUBJECT'] ?? '',
};
