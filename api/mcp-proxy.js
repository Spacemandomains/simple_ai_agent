// Streamable-HTTP MCP proxy that forwards requests to the Hawaii Conditions
// MCP server while injecting the `X-Payment-Token` header expected by its
// Stripe-based auth. Anthropic's `mcp_servers` parameter points at this
// endpoint instead of the upstream server directly, since `mcp_servers` only
// supports bearer-style `Authorization` headers.

const UPSTREAM = 'https://hawaii-conditions.vercel.app/mcp';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  const paymentToken = process.env.HAWAII_PAYMENT_TOKEN;

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

  const upstream = await fetch(UPSTREAM, {
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
