import pg from 'pg';

const { Pool } = pg;

const HAWAII_MCP_ACCOUNT_HEADER = 'X-MCP-Account';
const DEFAULT_AGENT_DISPLAY_NAME = 'Hawaii Conditions User';

let _pool: pg.Pool | null = null;

function getPool() {
    if (!_pool) {
      const connStr = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
      if (!connStr) throw new Error('No database connection string set (NEON_DATABASE_URL or DATABASE_URL)');
      _pool = new Pool({
        connectionString: connStr,
        ssl: process.env.NEON_DATABASE_URL ? { rejectUnauthorized: false } : undefined,
      });
    }
    return _pool;
  }

async function sql(strings: TemplateStringsArray, ...values: unknown[]) {
  const client = getPool();
  let query = '';
  const params: unknown[] = [];
  strings.forEach((str, i) => {
    query += str;
    if (i < values.length) {
      params.push(values[i]);
      query += `$${params.length}`;
    }
  });
  const result = await client.query(query, params);
  return result.rows;
}

function dollarsToCents(value: unknown): number | null {
  if (typeof value === 'number') return Math.round(value * 100);
  if (typeof value !== 'string') return null;
  const cleaned = (value as string).replace(/[$,]/g, '').trim();
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

function getAgentPaymentIdentity() {
  return {
    display_name: process.env.HAWAII_CONDITIONS_AGENT_NAME || DEFAULT_AGENT_DISPLAY_NAME,
    agent_id: process.env.AGENT_ID || 'simple-ai-agent',
    payment_provider: process.env.PAYMENT_PROVIDER || 'stripe',
    stripe_customer_id: process.env.STRIPE_CUSTOMER_ID || undefined,
    provider_customer_id: process.env.PAYMENT_PROVIDER_CUSTOMER_ID || process.env.STRIPE_CUSTOMER_ID || undefined,
  };
}

function withAgentPaymentIdentity(name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  if (name !== 'register_agent') return args;
  return { ...(args || {}), ...getAgentPaymentIdentity() };
}

function normalizeBalanceCents(parsed: Record<string, unknown> | null): number | null {
  if (!parsed || typeof parsed !== 'object') return null;
  if (Number.isFinite(parsed.balance_cents)) return parsed.balance_cents as number;
  if (Number.isFinite(parsed.balance)) return parsed.balance as number;
  if (parsed.balance_usd) return dollarsToCents(parsed.balance_usd);
  return null;
}

async function ensureSchema() {
  const pool = getPool();
  await pool.query(`
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
  `);
  await pool.query(`ALTER TABLE mcp_accounts ADD COLUMN IF NOT EXISTS agent_id TEXT`);
  await pool.query(`ALTER TABLE mcp_accounts ADD COLUMN IF NOT EXISTS payment_provider TEXT`);
  await pool.query(`ALTER TABLE mcp_accounts ADD COLUMN IF NOT EXISTS provider_customer_id TEXT`);
    await pool.query(`ALTER TABLE mcp_accounts ADD COLUMN IF NOT EXISTS stripe_payment_method_id TEXT`);
  await pool.query(`
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
  `);
  await pool.query(`ALTER TABLE mcp_balance_history ADD COLUMN IF NOT EXISTS agent_id TEXT`);
  await pool.query(`ALTER TABLE mcp_balance_history ADD COLUMN IF NOT EXISTS payment_provider TEXT`);
  await pool.query(`ALTER TABLE mcp_balance_history ADD COLUMN IF NOT EXISTS provider_customer_id TEXT`);
}

async function getAccountFromDB(url: string) {
  await ensureSchema();
  const pool = getPool();
  const result = await pool.query('SELECT * FROM mcp_accounts WHERE mcp_url = $1 LIMIT 1', [url]);
  return result.rows[0] || null;
}

async function saveAccount(url: string, parsed: Record<string, unknown>) {
  await ensureSchema();
  if (!parsed?.api_key) return;
  const identity = getAgentPaymentIdentity();
  const balanceCents = normalizeBalanceCents(parsed);
  const stripeCustomerId = (parsed.stripe_customer_id as string) || identity.stripe_customer_id || null;
  const providerCustomerId = (parsed.provider_customer_id as string) || identity.provider_customer_id || stripeCustomerId;
  const pool = getPool();
  await pool.query(
    `INSERT INTO mcp_accounts (mcp_url, api_key, account_id, stripe_customer_id, display_name, agent_id, payment_provider, provider_customer_id, last_balance_cents, last_balance_usd, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
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
       updated_at = NOW()`,
    [
      url, parsed.api_key, (parsed.account_id as string) || null,
      stripeCustomerId, (parsed.display_name as string) || identity.display_name,
      identity.agent_id, identity.payment_provider, providerCustomerId,
      balanceCents, (parsed.balance_usd as string) || null,
    ]
  );
}

async function recordBalanceSnapshot(url: string, toolName: string, parsed: Record<string, unknown> | null) {
  if (!parsed) return;
  const balanceCents = normalizeBalanceCents(parsed);
  const hasBalance = balanceCents !== null || parsed?.balance_usd;
  if (!hasBalance) return;
  await ensureSchema();
  const existing = await getAccountFromDB(url);
  const identity = getAgentPaymentIdentity();
  const stripeCustomerId = (parsed.stripe_customer_id as string) || existing?.stripe_customer_id || identity.stripe_customer_id || null;
  const providerCustomerId = (parsed.provider_customer_id as string) || existing?.provider_customer_id || identity.provider_customer_id || stripeCustomerId;
  const pool = getPool();
  await pool.query(
    `INSERT INTO mcp_balance_history (mcp_url, account_id, stripe_customer_id, agent_id, payment_provider, provider_customer_id, tool_name, balance_cents, balance_usd, raw_response)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      url, (parsed.account_id as string) || existing?.account_id || null,
      stripeCustomerId, identity.agent_id, identity.payment_provider, providerCustomerId,
      toolName, balanceCents, (parsed.balance_usd as string) || null, JSON.stringify(parsed),
    ]
  );
  await pool.query(
    `UPDATE mcp_accounts
     SET account_id = COALESCE($1, account_id),
         stripe_customer_id = COALESCE($2, stripe_customer_id),
         agent_id = COALESCE($3, agent_id),
         payment_provider = COALESCE($4, payment_provider),
         provider_customer_id = COALESCE($5, provider_customer_id),
         last_balance_cents = COALESCE($6, last_balance_cents),
         last_balance_usd = COALESCE($7, last_balance_usd),
         updated_at = NOW()
     WHERE mcp_url = $8`,
    [
      (parsed.account_id as string) || null, stripeCustomerId,
      identity.agent_id, identity.payment_provider, providerCustomerId,
      balanceCents, (parsed.balance_usd as string) || null, url,
    ]
  );
}

function extractTextContent(resp: Record<string, unknown>): string {
  const content = (resp?.result as any)?.content ?? [];
  return (content as any[])
    .map((item: any) => item?.text ?? (typeof item === 'string' ? item : JSON.stringify(item)))
    .join('\n');
}

function parseToolJson(resp: Record<string, unknown>): Record<string, unknown> | null {
  const text = extractTextContent(resp).trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function isAuthenticationRequired(resp: Record<string, unknown>): boolean {
  const parsed = parseToolJson(resp);
  return (parsed as any)?.error === 'authentication_required';
}

function isToolPaymentRequired(parsed: Record<string, unknown> | null): boolean {
  return !!(parsed?.status === 'payment_required' && (parsed as any)?.payment_intent_id);
}

function isToolSetupRequired(parsed: Record<string, unknown> | null): boolean {
  return !!(parsed?.status === 'setup_required' && (parsed as any)?.setup_intent_id && (parsed as any)?.client_secret);
}

function toWalletPaymentRequired(parsed: Record<string, unknown>, toolName: string) {
  return {
    tool: (parsed as any).topup_tool || toolName,
    price_usd: (parsed as any).amount_usd,
    amount_cents: (parsed as any).amount_cents,
    currency: (parsed as any).currency || 'usd',
    payment_methods: {
      stripe_per_call: {
        payment_intent: { id: (parsed as any).payment_intent_id, client_secret: (parsed as any).client_secret },
        publishable_key: (parsed as any).publishable_key,
      },
    },
    raw: parsed,
  };
}

function toWalletSetupRequired(parsed: Record<string, unknown>, toolName: string) {
  return {
    tool: toolName,
    status: 'setup_required',
    setup_intent_id: (parsed as any).setup_intent_id,
    client_secret: (parsed as any).client_secret,
    publishable_key: (parsed as any).publishable_key,
    stripe_customer_id: (parsed as any).stripe_customer_id,
    raw: parsed,
  };
}

function throwIfToolPaymentRequired(parsed: Record<string, unknown> | null, toolName: string) {
  if (isToolSetupRequired(parsed)) {
    const err = new Error('Wallet setup required');
    (err as any).paymentRequired = toWalletSetupRequired(parsed!, toolName);
    throw err;
  }
  if (!isToolPaymentRequired(parsed)) return;
  const err = new Error('Payment required');
  (err as any).paymentRequired = toWalletPaymentRequired(parsed!, toolName);
  throw err;
}

async function post(
  url: string, method: string, params: unknown, id: number | string,
  paymentToken: string | undefined, accountKey: string | undefined
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
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
      try { (err as any).paymentRequired = JSON.parse(body); } catch { (err as any).paymentRequired = { raw: body }; }
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

  return res.json() as Promise<Record<string, unknown>>;
}

async function callRawTool(url: string, name: string, args: Record<string, unknown>, paymentToken: string | undefined, accountKey: string | undefined) {
  return post(url, 'tools/call', { name, arguments: withAgentPaymentIdentity(name, args) ?? {} }, Date.now(), paymentToken, accountKey);
}

async function registerAgent(url: string, paymentToken: string | undefined): Promise<Record<string, unknown> | null> {
  const resp = await callRawTool(url, 'register_agent', getAgentPaymentIdentity() as Record<string, unknown>, paymentToken, undefined);
  const parsed = parseToolJson(resp);
  if (parsed?.api_key) {
    await saveAccount(url, parsed);
    await recordBalanceSnapshot(url, 'register_agent', parsed);
  }
  return parsed;
}

async function processToolResponse(url: string, toolName: string, resp: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const parsed = parseToolJson(resp);
  if (!parsed) return parsed;
  if (toolName === 'register_agent' && (parsed as any).api_key) {
    await saveAccount(url, parsed);
  }
  await recordBalanceSnapshot(url, toolName, parsed);
  return parsed;
}

export async function discoverTools(url: string, paymentToken: string | undefined) {
  const account = await getAccountFromDB(url);
  await post(url, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent', version: '1.0' } }, 1, paymentToken, account?.api_key);
  const resp = await post(url, 'tools/list', {}, 2, paymentToken, account?.api_key);
  return (resp?.result as any)?.tools ?? [];
}

export async function invokeTool(url: string, name: string, args: Record<string, unknown>, paymentToken: string | undefined) {
  let account = await getAccountFromDB(url);
  let accountKey = account?.api_key || null;

  let resp = await callRawTool(url, name, args, paymentToken, accountKey);

  if (name === 'register_agent') {
    const parsed = await processToolResponse(url, name, resp);
    throwIfToolPaymentRequired(parsed, name);
    return (resp?.result as any)?.content ?? [];
  }

  if (isAuthenticationRequired(resp)) {
    const registration = await registerAgent(url, paymentToken);
    accountKey = (registration as any)?.api_key;
    if (accountKey) {
      resp = await callRawTool(url, name, args, paymentToken, accountKey);
    }
  }

  const parsed = await processToolResponse(url, name, resp);
  throwIfToolPaymentRequired(parsed, name);

  return (resp?.result as any)?.content ?? [];
}
