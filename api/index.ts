import { createAppInstance } from '../src/app';

// Node.js 15+ crashes the process on unhandled rejections. Postgres background work
// (idle-connection teardown, reconnect probes) can produce these in serverless.
// Registering this handler prevents Lambda crashes; the error is still logged.
process.on('unhandledRejection', (reason: unknown) => {
  console.error('[CMS] unhandledRejection:', reason);
});

let appPromise: ReturnType<typeof createAppInstance> | null = null;

function getApp() {
  if (!appPromise) {
    appPromise = createAppInstance().catch((err) => {
      console.error('[CMS] createAppInstance failed:', err);
      appPromise = null;
      throw err;
    });
  }
  return appPromise;
}

async function handler(req: any, res: any): Promise<void> {
  try {
    const app = await getApp();
    app(req, res);
  } catch (err) {
    console.error('[CMS] handler error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

module.exports = handler;
