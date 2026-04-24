import { walletStatus } from '../../lib/wallet.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const status = await walletStatus();
    return res.status(200).json(status);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
