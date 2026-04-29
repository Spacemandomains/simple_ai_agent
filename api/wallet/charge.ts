import type { VercelRequest, VercelResponse } from '@vercel/node';
  import { confirmPayment, mapWalletErrorToStatus } from '../../lib/wallet.js';

  export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
    const { paymentIntentId, expectedAmountCents, metadata } = req.body || {};
    try {
      const result = await confirmPayment({ paymentIntentId, expectedAmountCents, metadata });
      res.status(200).json(result);
    } catch (err: any) {
      const status = mapWalletErrorToStatus(err.code);
      res.status(status).json({
        error: err.message,
        code: err.code || 'UNKNOWN',
        daily_spend_cents: err.daily_spend_cents,
        daily_limit_cents: err.daily_limit_cents,
        per_call_limit_cents: err.per_call_limit_cents,
        amount_cents: err.amount_cents,
      });
    }
  }
  