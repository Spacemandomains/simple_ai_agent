import { verifyPayment } from '../../lib/wallet.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const id = req.query?.payment_intent_id || req.query?.id;
  if (!id) return res.status(400).json({ error: 'Missing payment_intent_id' });

  try {
    const result = await verifyPayment(id);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
