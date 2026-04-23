// Streamable-HTTP MCP proxy for Anthropic's mcp_servers feature.
// Target URL and payment token are passed as query params:
//   /api/mcp-proxy?target=<encoded-mcp-url>&token=<payment-token>

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  const target = req.query?.target;
  if (!target) return res.status(400).json({ error: 'Missing ?target query param' });

  const paymentToken = req.query?.token || process.env.MCP_PAYMENT_TOKEN;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lower = k.toLowerCase();
    if (lower === 'host' || lower === 'connection' || lower === 'content-length') continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  if (paymentToken) headers['X-Payment-Token'] = paymentToken;

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  const upstream = await fetch(target, {
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
}
