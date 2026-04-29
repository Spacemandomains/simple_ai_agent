import type { VercelRequest, VercelResponse } from '@vercel/node';
  import { verifyPayment } from '../../lib/wallet.js';

  export default async function handler(req: VercelRequest, res: VercelResponse) {
    const id = (req.query?.payment_intent_id || req.query?.id) as string | undefined;
    if (!id) { res.status(400).json({ error: 'Missing payment_intent_id' }); return; }
    try {
      const result = await verifyPayment(id);
      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
  