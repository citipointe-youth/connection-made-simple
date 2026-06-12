import { createAppInstance } from '../src/app';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const appPromise = createAppInstance();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const app = await appPromise;
  app(req as any, res as any);
}
