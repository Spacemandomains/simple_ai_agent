import { confirmPayment, mapWalletErrorToStatus } from '../../lib/wallet.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { paymentIntentId, expectedAmountCents, metadata } = body || {};

  try {
    const result = await confirmPayment({ paymentIntentId, expectedAmountCents, metadata });
    return res.status(200).json(result);
  } catch (err) {
    const status = mapWalletErrorToStatus(err.code);
    return res.status(status).json({
      error: err.message,
      code: err.code || 'UNKNOWN',
      daily_spend_cents:    err.daily_spend_cents,
      daily_limit_cents:    err.daily_limit_cents,
      per_call_limit_cents: err.per_call_limit_cents,
      amount_cents:         err.amount_cents,
    });
  }
}
