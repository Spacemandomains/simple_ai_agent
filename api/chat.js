import Anthropic from '@anthropic-ai/sdk';

export const config = { runtime: 'nodejs' };

const MODEL = 'claude-sonnet-4-6';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });
    return;
  }

  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }

  const messages = Array.isArray(payload?.messages) ? payload.messages : null;
  if (!messages) {
    res.status(400).json({ error: 'Missing messages array' });
    return;
  }

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const mcpProxyUrl = `${proto}://${host}/api/mcp-proxy`;

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    defaultHeaders: { 'anthropic-beta': 'mcp-client-2025-04-04' },
  });

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system:
        'You are a friendly assistant for testing the Hawaii Conditions MCP server. ' +
        'Use the available MCP tools to answer questions about Hawaii weather, surf, ' +
        'trails, volcanoes, ocean safety, and restaurants. Be concise.',
      messages,
      mcp_servers: [
        {
          type: 'url',
          url: mcpProxyUrl,
          name: 'hawaii-conditions',
        },
      ],
    });

    res.status(200).json(response);
  } catch (err) {
    res.status(500).json({
      error: err?.message || 'Request failed',
      details: err?.error || null,
    });
  }
}
