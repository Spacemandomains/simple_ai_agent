import type { VercelRequest, VercelResponse } from '@vercel/node';
  import { walletStatus } from '../../lib/wallet.js';

  export default async function handler(_req: VercelRequest, res: VercelResponse) {
    try {
      const status = await walletStatus();
      res.status(200).json(status);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
  