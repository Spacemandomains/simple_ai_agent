// Server-side MCP JSON-RPC client for all providers.

async function post(url, method, params, id, paymentToken) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (paymentToken) headers['X-Payment-Token'] = paymentToken;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 402) {
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = { raw: body }; }
      const err = new Error('Payment required');
      err.paymentRequired = parsed;
      throw err;
    }
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

export async function discoverTools(url, paymentToken) {
  await post(url, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-test-agent', version: '0.1.0' },
  }, 1, paymentToken);
  const resp = await post(url, 'tools/list', {}, 2, paymentToken);
  return resp?.result?.tools ?? [];
}

export async function invokeTool(url, name, args, paymentToken) {
  const resp = await post(url, 'tools/call', { name, arguments: args ?? {} }, Date.now(), paymentToken);
  return resp?.result?.content ?? [];
}
