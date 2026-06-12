import { createAppInstance } from '../src/app';

const appPromise = createAppInstance();

async function handler(req: any, res: any): Promise<void> {
  const app = await appPromise;
  app(req, res);
}

export = handler;
