import { Router } from 'express';
import { walletStatus, confirmPayment, verifyPayment, mapWalletErrorToStatus } from '../lib/wallet.js';

const router = Router();

router.get('/wallet/status', async (req, res) => {
  try {
    const status = await walletStatus();
    return res.status(200).json(status);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/wallet/charge', async (req, res) => {
  const { paymentIntentId, expectedAmountCents, metadata } = req.body || {};
  try {
    const result = await confirmPayment({ paymentIntentId, expectedAmountCents, metadata });
    return res.status(200).json(result);
  } catch (err: any) {
    const status = mapWalletErrorToStatus(err.code);
    return res.status(status).json({
      error: err.message,
      code: err.code || 'UNKNOWN',
      daily_spend_cents: err.daily_spend_cents,
      daily_limit_cents: err.daily_limit_cents,
      per_call_limit_cents: err.per_call_limit_cents,
      amount_cents: err.amount_cents,
    });
  }
});

router.get('/wallet/verify', async (req, res) => {
  const id = (req.query as any)?.payment_intent_id || (req.query as any)?.id;
  if (!id) return res.status(400).json({ error: 'Missing payment_intent_id' });
  try {
    const result = await verifyPayment(id as string);
    return res.status(200).json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
