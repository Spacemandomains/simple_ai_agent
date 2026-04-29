import type { VercelRequest, VercelResponse } from '@vercel/node';

  export default async function handler(req: VercelRequest, res: VercelResponse) {
    const target = req.query?.target as string | undefined;
    if (!target) { res.status(400).json({ error: 'Missing ?target query param' }); return; }

    const paymentToken = (req.query?.token as string) || process.env.MCP_PAYMENT_TOKEN;

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
        (req as any).on('data', (c: Buffer) => chunks.push(c));
        (req as any).on('end', () => resolve(Buffer.concat(chunks)));
        (req as any).on('error', reject);
      });
    }

    const upstream = await fetch(target, {
      method: req.method ?? 'GET',
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
  }
  