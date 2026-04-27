// Server-side MCP JSON-RPC client for all providers.

const HAWAII_MCP_ACCOUNT_HEADER = 'X-MCP-Account';
const DEFAULT_AGENT_DISPLAY_NAME = 'Hawaii Conditions User';

// Best-effort runtime persistence for server processes. On serverless platforms,
// memory can reset between invocations, so the agent also re-registers and retries
// automatically when the MCP server reports authentication_required.
const mcpAccountKeys = new Map();

function getCachedAccountKey(url) {
  return process.env.HAWAII_CONDITIONS_MCP_ACCOUNT_KEY || mcpAccountKeys.get(url);
}

function cacheAccountKey(url, apiKey) {
  if (apiKey) mcpAccountKeys.set(url, apiKey);
}

function extractTextContent(resp) {
  const content = resp?.result?.content ?? [];
  return content
    .map((item) => item?.text ?? (typeof item === 'string' ? item : JSON.stringify(item)))
    .join('\n');
}

function parseToolJson(resp) {
  const text = extractTextContent(resp).trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isAuthenticationRequired(resp) {
  const parsed = parseToolJson(resp);
  return parsed?.error === 'authentication_required';
}

async function post(url, method, params, id, paymentToken, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  // Sends your MCP API key to protected MCP servers.
  // Add MCP_API_KEY in Vercel Environment Variables when the MCP server expects
  // standard Authorization Bearer auth.
  if (process.env.MCP_API_KEY) {
    headers.Authorization = `Bearer ${process.env.MCP_API_KEY}`;
  }

  // Sends the Hawaii Conditions account key on all calls after registration.
  // The key can come from runtime registration or an optional env fallback.
  const accountKey = options.accountKey ?? getCachedAccountKey(url);
  if (accountKey) {
    headers[HAWAII_MCP_ACCOUNT_HEADER] = accountKey;
  }

  if (paymentToken) headers['X-Payment-Token'] = paymentToken;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
    signal: AbortSignal.timeout(50_000),
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

async function callRawTool(url, name, args, paymentToken, options = {}) {
  return post(
    url,
    'tools/call',
    { name, arguments: args ?? {} },
    Date.now(),
    paymentToken,
    options
  );
}

async function registerAgent(url, paymentToken) {
  const displayName = process.env.HAWAII_CONDITIONS_AGENT_NAME || DEFAULT_AGENT_DISPLAY_NAME;
  const resp = await callRawTool(url, 'register_agent', { display_name: displayName }, paymentToken, {
    accountKey: null,
  });

  const parsed = parseToolJson(resp);
  if (parsed?.api_key) {
    cacheAccountKey(url, parsed.api_key);
  }

  return parsed;
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
  let resp = await callRawTool(url, name, args, paymentToken);

  const parsed = parseToolJson(resp);
  if (name === 'register_agent' && parsed?.api_key) {
    cacheAccountKey(url, parsed.api_key);
    return resp?.result?.content ?? [];
  }

  if (isAuthenticationRequired(resp)) {
    const registration = await registerAgent(url, paymentToken);

    if (!registration?.api_key) {
      return resp?.result?.content ?? [];
    }

    resp = await callRawTool(url, name, args, paymentToken, {
      accountKey: registration.api_key,
    });
  }

  return resp?.result?.content ?? [];
}
