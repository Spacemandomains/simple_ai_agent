import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

const HAWAII_MCP_ACCOUNT_HEADER = 'X-MCP-Account';
const DEFAULT_AGENT_DISPLAY_NAME = 'Hawaii Conditions User';

async function getAccountKeyFromDB(url) {
  const result = await sql`SELECT api_key FROM mcp_accounts WHERE mcp_url = ${url} LIMIT 1`;
  return result[0]?.api_key || null;
}

async function saveAccountKey(url, apiKey) {
  await sql`
    INSERT INTO mcp_accounts (mcp_url, api_key)
    VALUES (${url}, ${apiKey})
    ON CONFLICT (mcp_url) DO UPDATE SET api_key = EXCLUDED.api_key
  `;
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
  try { return JSON.parse(text); } catch { return null; }
}

function isAuthenticationRequired(resp) {
  const parsed = parseToolJson(resp);
  return parsed?.error === 'authentication_required';
}

async function post(url, method, params, id, paymentToken, accountKey) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  if (accountKey) headers[HAWAII_MCP_ACCOUNT_HEADER] = accountKey;
  if (paymentToken) headers['X-Payment-Token'] = paymentToken;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 402) {
      const err = new Error('Payment required');
      err.paymentRequired = JSON.parse(body);
      throw err;
    }
    throw new Error(`MCP ${res.status}: ${body}`);
  }

  return res.json();
}

async function callRawTool(url, name, args, paymentToken, accountKey) {
  return post(url, 'tools/call', { name, arguments: args ?? {} }, Date.now(), paymentToken, accountKey);
}

async function registerAgent(url, paymentToken) {
  const resp = await callRawTool(url, 'register_agent', { display_name: DEFAULT_AGENT_DISPLAY_NAME }, paymentToken);
  const parsed = parseToolJson(resp);

  if (parsed?.api_key) {
    await saveAccountKey(url, parsed.api_key);
  }

  return parsed;
}

export async function discoverTools(url, paymentToken) {
  await post(url, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent', version: '1.0' } }, 1, paymentToken);
  const resp = await post(url, 'tools/list', {}, 2, paymentToken);
  return resp?.result?.tools ?? [];
}

export async function invokeTool(url, name, args, paymentToken) {
  let accountKey = await getAccountKeyFromDB(url);

  let resp = await callRawTool(url, name, args, paymentToken, accountKey);

  if (isAuthenticationRequired(resp)) {
    const registration = await registerAgent(url, paymentToken);
    accountKey = registration?.api_key;

    if (accountKey) {
      resp = await callRawTool(url, name, args, paymentToken, accountKey);
    }
  }

  return resp?.result?.content ?? [];
}
