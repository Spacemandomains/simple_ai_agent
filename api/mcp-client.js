import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

const HAWAII_MCP_ACCOUNT_HEADER = 'X-MCP-Account';
const DEFAULT_AGENT_DISPLAY_NAME = 'Hawaii Conditions User';

function dollarsToCents(value) {
  if (typeof value === 'number') return Math.round(value * 100);
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[$,]/g, '').trim();
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

function getAgentPaymentIdentity() {
  return {
    display_name: process.env.HAWAII_CONDITIONS_AGENT_NAME || DEFAULT_AGENT_DISPLAY_NAME,
    agent_id: process.env.AGENT_ID || process.env.VERCEL_PROJECT_PRODUCTION_URL || 'simple-ai-agent',
    payment_provider: process.env.PAYMENT_PROVIDER || 'stripe',
    stripe_customer_id: process.env.STRIPE_CUSTOMER_ID || undefined,
    provider_customer_id: process.env.PAYMENT_PROVIDER_CUSTOMER_ID || process.env.STRIPE_CUSTOMER_ID || undefined,
  };
}

function withAgentPaymentIdentity(name, args = {}) {
  if (name !== 'register_agent') return args;
  return {
    ...(args || {}),
    ...getAgentPaymentIdentity(),
  };
}

function normalizeBalanceCents(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (Number.isFinite(parsed.balance_cents)) return parsed.balance_cents;
  if (Number.isFinite(parsed.balance)) return parsed.balance;
  if (parsed.balance_usd) return dollarsToCents(parsed.balance_usd);
  return null;
}

async function ensureSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS mcp_accounts (
      id SERIAL PRIMARY KEY,
      mcp_url TEXT UNIQUE NOT NULL,
      api_key TEXT NOT NULL,
      account_id TEXT,
      stripe_customer_id TEXT,
      display_name TEXT,
      last_balance_cents INTEGER,
      last_balance_usd TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await sql`ALTER TABLE mcp_accounts ADD COLUMN IF NOT EXISTS agent_id TEXT`;
  await sql`ALTER TABLE mcp_accounts ADD COLUMN IF NOT EXISTS payment_provider TEXT`;
  await sql`ALTER TABLE mcp_accounts ADD COLUMN IF NOT EXISTS provider_customer_id TEXT`;

  await sql`
    CREATE TABLE IF NOT EXISTS mcp_balance_history (
      id SERIAL PRIMARY KEY,
      mcp_url TEXT NOT NULL,
      account_id TEXT,
      stripe_customer_id TEXT,
      tool_name TEXT,
      balance_cents INTEGER,
      balance_usd TEXT,
      raw_response JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await sql`ALTER TABLE mcp_balance_history ADD COLUMN IF NOT EXISTS agent_id TEXT`;
  await sql`ALTER TABLE mcp_balance_history ADD COLUMN IF NOT EXISTS payment_provider TEXT`;
  await sql`ALTER TABLE mcp_balance_history ADD COLUMN IF NOT EXISTS provider_customer_id TEXT`;
}

async function getAccountFromDB(url) {
  await ensureSchema();
  const result = await sql`SELECT * FROM mcp_accounts WHERE mcp_url = ${url} LIMIT 1`;
  return result[0] || null;
}

async function saveAccount(url, parsed) {
  await ensureSchema();
  if (!parsed?.api_key) return;

  const identity = getAgentPaymentIdentity();
  const balanceCents = normalizeBalanceCents(parsed);
  const stripeCustomerId = parsed.stripe_customer_id || identity.stripe_customer_id || null;
  const providerCustomerId = parsed.provider_customer_id || identity.provider_customer_id || stripeCustomerId;

  await sql`
    INSERT INTO mcp_accounts (
      mcp_url,
      api_key,
      account_id,
      stripe_customer_id,
      display_name,
      agent_id,
      payment_provider,
      provider_customer_id,
      last_balance_cents,
      last_balance_usd,
      updated_at
    )
    VALUES (
      ${url},
      ${parsed.api_key},
      ${parsed.account_id || null},
      ${stripeCustomerId},
      ${parsed.display_name || identity.display_name},
      ${identity.agent_id},
      ${identity.payment_provider},
      ${providerCustomerId},
      ${balanceCents},
      ${parsed.balance_usd || null},
      NOW()
    )
    ON CONFLICT (mcp_url) DO UPDATE SET
      api_key = EXCLUDED.api_key,
      account_id = COALESCE(EXCLUDED.account_id, mcp_accounts.account_id),
      stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, mcp_accounts.stripe_customer_id),
      display_name = COALESCE(EXCLUDED.display_name, mcp_accounts.display_name),
      agent_id = COALESCE(EXCLUDED.agent_id, mcp_accounts.agent_id),
      payment_provider = COALESCE(EXCLUDED.payment_provider, mcp_accounts.payment_provider),
      provider_customer_id = COALESCE(EXCLUDED.provider_customer_id, mcp_accounts.provider_customer_id),
      last_balance_cents = COALESCE(EXCLUDED.last_balance_cents, mcp_accounts.last_balance_cents),
      last_balance_usd = COALESCE(EXCLUDED.last_balance_usd, mcp_accounts.last_balance_usd),
      updated_at = NOW()
  `;
}

async function recordBalanceSnapshot(url, toolName, parsed) {
  const balanceCents = normalizeBalanceCents(parsed);
  const hasBalance = balanceCents !== null || parsed?.balance_usd;
  if (!hasBalance) return;

  await ensureSchema();
  const existing = await getAccountFromDB(url);
  const identity = getAgentPaymentIdentity();
  const stripeCustomerId = parsed.stripe_customer_id || existing?.stripe_customer_id || identity.stripe_customer_id || null;
  const providerCustomerId = parsed.provider_customer_id || existing?.provider_customer_id || identity.provider_customer_id || stripeCustomerId;

  await sql`
    INSERT INTO mcp_balance_history (
      mcp_url,
      account_id,
      stripe_customer_id,
      agent_id,
      payment_provider,
      provider_customer_id,
      tool_name,
      balance_cents,
      balance_usd,
      raw_response
    )
    VALUES (
      ${url},
      ${parsed.account_id || existing?.account_id || null},
      ${stripeCustomerId},
      ${identity.agent_id},
      ${identity.payment_provider},
      ${providerCustomerId},
      ${toolName},
      ${balanceCents},
      ${parsed.balance_usd || null},
      ${JSON.stringify(parsed)}::jsonb
    )
  `;

  await sql`
    UPDATE mcp_accounts
    SET
      account_id = COALESCE(${parsed.account_id || null}, account_id),
      stripe_customer_id = COALESCE(${stripeCustomerId}, stripe_customer_id),
      agent_id = COALESCE(${identity.agent_id}, agent_id),
      payment_provider = COALESCE(${identity.payment_provider}, payment_provider),
      provider_customer_id = COALESCE(${providerCustomerId}, provider_customer_id),
      last_balance_cents = COALESCE(${balanceCents}, last_balance_cents),
      last_balance_usd = COALESCE(${parsed.balance_usd || null}, last_balance_usd),
      updated_at = NOW()
    WHERE mcp_url = ${url}
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

function isToolPaymentRequired(parsed) {
  return parsed?.status === 'payment_required' && parsed?.payment_intent_id;
}

function toWalletPaymentRequired(parsed, toolName) {
  return {
    tool: parsed.topup_tool || toolName,
    price_usd: parsed.amount_usd,
    amount_cents: parsed.amount_cents,
    currency: parsed.currency || 'usd',
    payment_methods: {
      stripe_per_call: {
        payment_intent: {
          id: parsed.payment_intent_id,
          client_secret: parsed.client_secret,
        },
        publishable_key: parsed.publishable_key,
      },
    },
    raw: parsed,
  };
}

function throwIfToolPaymentRequired(parsed, toolName) {
  if (!isToolPaymentRequired(parsed)) return;
  const err = new Error('Payment required');
  err.paymentRequired = toWalletPaymentRequired(parsed, toolName);
  throw err;
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
      try { err.paymentRequired = JSON.parse(body); } catch { err.paymentRequired = { raw: body }; }
      throw err;
    }
    throw new Error(`MCP ${res.status}: ${body}`);
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

async function callRawTool(url, name, args, paymentToken, accountKey) {
  return post(url, 'tools/call', { name, arguments: withAgentPaymentIdentity(name, args) ?? {} }, Date.now(), paymentToken, accountKey);
}

async function registerAgent(url, paymentToken) {
  const resp = await callRawTool(url, 'register_agent', getAgentPaymentIdentity(), paymentToken);
  const parsed = parseToolJson(resp);

  if (parsed?.api_key) {
    await saveAccount(url, parsed);
    await recordBalanceSnapshot(url, 'register_agent', parsed);
  }

  return parsed;
}

async function processToolResponse(url, toolName, resp) {
  const parsed = parseToolJson(resp);
  if (!parsed) return parsed;

  if (toolName === 'register_agent' && parsed.api_key) {
    await saveAccount(url, parsed);
  }

  await recordBalanceSnapshot(url, toolName, parsed);
  return parsed;
}

export async function discoverTools(url, paymentToken) {
  const account = await getAccountFromDB(url);

  await post(
    url,
    'initialize',
    { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent', version: '1.0' } },
    1,
    paymentToken,
    account?.api_key
  );

  const resp = await post(url, 'tools/list', {}, 2, paymentToken, account?.api_key);
  return resp?.result?.tools ?? [];
}

export async function invokeTool(url, name, args, paymentToken) {
  let account = await getAccountFromDB(url);
  let accountKey = account?.api_key || null;

  let resp = await callRawTool(url, name, args, paymentToken, accountKey);

  if (name === 'register_agent') {
    const parsed = await processToolResponse(url, name, resp);
    throwIfToolPaymentRequired(parsed, name);
    return resp?.result?.content ?? [];
  }

  if (isAuthenticationRequired(resp)) {
    const registration = await registerAgent(url, paymentToken);
    accountKey = registration?.api_key;

    if (accountKey) {
      resp = await callRawTool(url, name, args, paymentToken, accountKey);
    }
  }

  const parsed = await processToolResponse(url, name, resp);
  throwIfToolPaymentRequired(parsed, name);

  return resp?.result?.content ?? [];
}
