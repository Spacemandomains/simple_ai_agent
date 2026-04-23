// Server-side MCP JSON-RPC client used by OpenAI and Gemini handlers.
// Anthropic uses its native mcp_servers parameter instead.

const UPSTREAM = 'https://hawaii-conditions.vercel.app/mcp';

async function post(method, params, id) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (process.env.HAWAII_PAYMENT_TOKEN) {
    headers['X-Payment-Token'] = process.env.HAWAII_PAYMENT_TOKEN;
  }

  const res = await fetch(UPSTREAM, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MCP ${res.status}: ${body.slice(0, 200)}`);
  }

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    const text = await res.text();
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try { return JSON.parse(data); } catch {}
    }
    throw new Error('Empty SSE response from MCP server');
  }
  return res.json();
}

let cachedTools = null;

export async function discoverTools() {
  if (cachedTools) return cachedTools;
  await post('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'simple-ai-agent', version: '0.1.0' },
  }, 1);
  const resp = await post('tools/list', {}, 2);
  cachedTools = resp?.result?.tools ?? [];
  return cachedTools;
}

export async function invokeTool(name, args) {
  const resp = await post('tools/call', { name, arguments: args ?? {} }, Date.now());
  return resp?.result?.content ?? [];
}
