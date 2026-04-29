import type { VercelRequest, VercelResponse } from '@vercel/node';
import { invokeTool, persistPaymentMethodId } from '../../lib/mcp-client';

type ContentBlock = { type: string; text?: string };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { mcpUrl, pmId } = req.body || {};
  if (!mcpUrl || !pmId) return res.status(400).json({ error: 'mcpUrl and pmId required' });
  try {
    const result = await invokeTool(mcpUrl, 'save_payment_method', { payment_method_id: pmId }, undefined);
    await persistPaymentMethodId(mcpUrl, pmId);
    const text = (result as ContentBlock[]).map((c) => c.text ?? JSON.stringify(c)).join('\n');
    return res.status(200).json({ ok: true, result: text });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: msg });
  }
}
