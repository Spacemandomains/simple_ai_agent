import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'nodejs' };

function mask(value) {
  if (!value) return null;
  if (value.length <= 10) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const env = {
    database_url_present: Boolean(process.env.DATABASE_URL),
    openai_key_present: Boolean(process.env.OPENAI_API_KEY),
    anthropic_key_present: Boolean(process.env.ANTHROPIC_API_KEY),
    google_key_present: Boolean(process.env.GOOGLE_API_KEY),
    stripe_secret_key_prefix: process.env.STRIPE_SECRET_KEY?.slice(0, 7) || null,
    stripe_customer_id: process.env.STRIPE_CUSTOMER_ID || null,
    payment_provider: process.env.PAYMENT_PROVIDER || 'stripe',
    payment_provider_customer_id: process.env.PAYMENT_PROVIDER_CUSTOMER_ID || null,
    agent_id: process.env.AGENT_ID || process.env.VERCEL_PROJECT_PRODUCTION_URL || 'simple-ai-agent',
    vercel_git_commit_sha: process.env.VERCEL_GIT_COMMIT_SHA || null,
    vercel_env: process.env.VERCEL_ENV || null,
  };

  if (!process.env.DATABASE_URL) {
    return res.status(200).json({ ok: true, env, db: { connected: false, error: 'DATABASE_URL missing' } });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);
    const tableRows = await sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('mcp_accounts', 'mcp_balance_history')
      ORDER BY table_name
    `;

    const accountRows = await sql`
      SELECT
        id,
        mcp_url,
        account_id,
        stripe_customer_id,
        agent_id,
        payment_provider,
        provider_customer_id,
        last_balance_cents,
        last_balance_usd,
        created_at,
        updated_at
      FROM mcp_accounts
      ORDER BY updated_at DESC
      LIMIT 5
    `;

    const balanceRows = await sql`
      SELECT
        id,
        account_id,
        stripe_customer_id,
        agent_id,
        payment_provider,
        provider_customer_id,
        tool_name,
        balance_cents,
        balance_usd,
        created_at
      FROM mcp_balance_history
      ORDER BY created_at DESC
      LIMIT 5
    `;

    res.status(200).json({
      ok: true,
      env: {
        ...env,
        stripe_customer_id: mask(env.stripe_customer_id),
        payment_provider_customer_id: mask(env.payment_provider_customer_id),
      },
      db: {
        connected: true,
        tables: tableRows.map((r) => r.table_name),
        mcp_accounts_count: accountRows.length,
        mcp_balance_history_count: balanceRows.length,
        latest_accounts: accountRows,
        latest_balance_history: balanceRows,
      },
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      env,
      db: {
        connected: false,
        error: err?.message || 'Unknown database error',
      },
    });
  }
}
