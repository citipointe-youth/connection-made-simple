async function handler(req: any, res: any): Promise<void> {
  res.json({ ok: true, service: 'connection-made-simple' });
}

export = handler;
