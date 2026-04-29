import { Router } from 'express';
import type { Request, Response } from 'express';

const router = Router();

router.all('/mcp-proxy', async (req: Request, res: Response) => {
  const target = (req.query as any)?.target;
  if (!target) return res.status(400).json({ error: 'Missing ?target query param' });

  const paymentToken = (req.query as any)?.token || process.env.MCP_PAYMENT_TOKEN;

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lower = k.toLowerCase();
    if (lower === 'host' || lower === 'connection' || lower === 'content-length') continue;
    headers[k] = Array.isArray(v) ? (v as string[]).join(', ') : (v as string);
  }
  if (paymentToken) headers['X-Payment-Token'] = paymentToken;

  let body: Buffer | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  const upstream = await fetch(target as string, {
    method: req.method,
    headers,
    body: body && body.length ? body : undefined,
  });

  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'content-encoding') return;
    if (key.toLowerCase() === 'transfer-encoding') return;
    res.setHeader(key, value);
  });

  if (upstream.body) {
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  }
  res.end();
});

export default router;
