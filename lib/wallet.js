// Stripe-backed agent wallet: enforces per-call and daily spend limits,
// confirms PaymentIntents off-session for a single pre-configured customer,
// and uses Stripe itself as the ledger (metadata.wallet = "agent" tags
// every charge made through this wallet).

const STRIPE_API = 'https://api.stripe.com/v1';

const CUSTOMER_ID         = () => {
  const id = process.env.STRIPE_CUSTOMER_ID;
  if (!id) throw new Error('STRIPE_CUSTOMER_ID is not configured');
  return id;
};
const DAILY_LIMIT_CENTS   = () => parseInt(process.env.WALLET_DAILY_LIMIT_CENTS   || '500', 10); // $5.00
const PER_CALL_LIMIT_CENTS = () => parseInt(process.env.WALLET_PER_CALL_LIMIT_CENTS || '200', 10); // $2.00

function stripeRequest(path, { method = 'GET', form } = {}) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is not configured');

  let url = `${STRIPE_API}${path}`;
  let body;
  if (form) {
    const encoded = new URLSearchParams(form).toString();
    if (method === 'GET') url += (url.includes('?') ? '&' : '?') + encoded;
    else body = encoded;
  }

  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(data?.error?.message || `Stripe ${r.status}`);
      err.stripe = data?.error;
      err.status = r.status;
      throw err;
    }
    return data;
  });
}

async function resolvePaymentMethodId() {
  const fromEnv = process.env.STRIPE_PAYMENT_METHOD_ID;
  if (fromEnv) return fromEnv;

  const customer = await stripeRequest(`/customers/${CUSTOMER_ID()}`);
  const pm = customer.invoice_settings?.default_payment_method;
  if (!pm) {
    throw new Error(
      'No default payment method on customer. Set STRIPE_PAYMENT_METHOD_ID or attach one in Stripe.'
    );
  }
  return typeof pm === 'string' ? pm : pm.id;
}

async function listWalletPayments(hours = 24) {
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const data = await stripeRequest('/payment_intents', {
    form: {
      customer: CUSTOMER_ID(),
      'created[gte]': String(since),
      limit: '100',
    },
  });
  return (data.data || []).filter(
    (pi) => pi.metadata?.wallet === 'agent' && pi.status === 'succeeded'
  );
}

async function getDailySpendCents() {
  const payments = await listWalletPayments(24);
  return payments.reduce((sum, pi) => sum + (pi.amount_received || pi.amount || 0), 0);
}

export async function walletStatus() {
  const payments = await listWalletPayments(24);
  const spent = payments.reduce((sum, pi) => sum + (pi.amount_received || pi.amount || 0), 0);
  const daily = DAILY_LIMIT_CENTS();
  return {
    customer_id:           CUSTOMER_ID(),
    currency:              'usd',
    daily_limit_cents:     daily,
    per_call_limit_cents:  PER_CALL_LIMIT_CENTS(),
    daily_spend_cents:     spent,
    remaining_cents:       Math.max(0, daily - spent),
    transactions: payments
      .sort((a, b) => b.created - a.created)
      .map((pi) => ({
        id:           pi.id,
        amount_cents: pi.amount_received || pi.amount,
        status:       pi.status,
        created:      pi.created,
        tool:         pi.metadata?.tool || null,
      })),
  };
}

// Confirm a specific existing PaymentIntent using the wallet's saved payment method.
// Enforces per-call and daily limits. Returns { payment_intent_id, status, amount_cents }.
export async function confirmPayment({ paymentIntentId, expectedAmountCents, metadata = {} }) {
  if (!paymentIntentId) {
    const err = new Error('paymentIntentId required');
    err.code = 'INVALID_REQUEST';
    throw err;
  }

  // Fetch PI to learn actual amount and current status
  const pi = await stripeRequest(`/payment_intents/${paymentIntentId}`);
  const amountCents = pi.amount;

  if (expectedAmountCents !== undefined && pi.amount !== expectedAmountCents) {
    const err = new Error(`PaymentIntent amount ${pi.amount}¢ does not match expected ${expectedAmountCents}¢`);
    err.code = 'AMOUNT_MISMATCH';
    throw err;
  }

  // Per-call limit
  if (amountCents > PER_CALL_LIMIT_CENTS()) {
    const err = new Error(
      `Amount ${amountCents}¢ exceeds per-call limit ${PER_CALL_LIMIT_CENTS()}¢`
    );
    err.code = 'PER_CALL_LIMIT_EXCEEDED';
    err.amount_cents = amountCents;
    err.per_call_limit_cents = PER_CALL_LIMIT_CENTS();
    throw err;
  }

  // If the PI was already paid (by someone), don't double-count; just return it.
  if (pi.status === 'succeeded') {
    const isWalletPaid = pi.metadata?.wallet === 'agent';
    return {
      payment_intent_id: pi.id,
      status:            'already_succeeded',
      amount_cents:      amountCents,
      wallet_managed:    isWalletPaid,
    };
  }

  // Daily limit (check against existing wallet spend only)
  const spent = await getDailySpendCents();
  if (spent + amountCents > DAILY_LIMIT_CENTS()) {
    const err = new Error(
      `Charge of ${amountCents}¢ would exceed daily limit: ${spent}¢ already spent of ${DAILY_LIMIT_CENTS()}¢`
    );
    err.code = 'DAILY_LIMIT_EXCEEDED';
    err.daily_spend_cents = spent;
    err.daily_limit_cents = DAILY_LIMIT_CENTS();
    err.amount_cents = amountCents;
    throw err;
  }

  const pmId = await resolvePaymentMethodId();

  // Stripe's /confirm endpoint does not accept `metadata`, and it rejects a
  // customer-owned `payment_method` unless the PI already carries that
  // `customer`. Do both in one update call before confirming.
  const updateForm = {
    'metadata[wallet]':       'agent',
    'metadata[purpose]':      'mcp-tool-call',
    'metadata[confirmed_at]': new Date().toISOString(),
  };
  if (!pi.customer) updateForm.customer = CUSTOMER_ID();
  for (const [k, v] of Object.entries(metadata)) {
    if (v !== undefined && v !== null) updateForm[`metadata[${k}]`] = String(v);
  }
  await stripeRequest(`/payment_intents/${paymentIntentId}`, {
    method: 'POST',
    form: updateForm,
  });

  const confirmed = await stripeRequest(`/payment_intents/${paymentIntentId}/confirm`, {
    method: 'POST',
    form: {
      payment_method: pmId,
      off_session:    'true',
    },
  });

  if (confirmed.status !== 'succeeded') {
    const err = new Error(`Payment did not reach 'succeeded' (status=${confirmed.status})`);
    err.code = 'PAYMENT_NOT_SUCCEEDED';
    err.stripe_status = confirmed.status;
    err.next_action = confirmed.next_action || null;
    throw err;
  }

  return {
    payment_intent_id: confirmed.id,
    status:            'succeeded',
    amount_cents:      confirmed.amount_received || confirmed.amount,
    wallet_managed:    true,
  };
}

export async function verifyPayment(paymentIntentId) {
  if (!paymentIntentId) {
    const err = new Error('paymentIntentId required');
    err.code = 'INVALID_REQUEST';
    throw err;
  }
  const pi = await stripeRequest(`/payment_intents/${paymentIntentId}`);
  return {
    payment_intent_id:       pi.id,
    status:                  pi.status,
    amount_cents:            pi.amount,
    amount_received_cents:   pi.amount_received,
    currency:                pi.currency,
    customer:                pi.customer,
    created:                 pi.created,
    metadata:                pi.metadata || {},
    wallet_managed:          pi.metadata?.wallet === 'agent',
  };
}

export function mapWalletErrorToStatus(code) {
  switch (code) {
    case 'INVALID_REQUEST':
    case 'AMOUNT_MISMATCH':
      return 400;
    case 'PER_CALL_LIMIT_EXCEEDED':
    case 'DAILY_LIMIT_EXCEEDED':
      return 402;
    case 'PAYMENT_NOT_SUCCEEDED':
      return 402;
    default:
      return 500;
  }
}
