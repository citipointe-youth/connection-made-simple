import { createAppInstance } from '../src/app';

const appPromise = createAppInstance();

export default async function handler(req: any, res: any): Promise<void> {
  const app = await appPromise;
  app(req, res);
}
