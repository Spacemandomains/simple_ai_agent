import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { discoverTools, invokeTool } from './mcp-client.js';

export const config = { runtime: 'nodejs' };

const SYSTEM =
  'You are a helpful assistant with access to tools provided by an MCP server. ' +
  'Use the available tools to answer questions accurately and concisely.';

// ── Anthropic ─────────────────────────────────────────────────────────────────
async function handleAnthropic(messages, req, mcpUrl, paymentToken) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;

  const proxyUrl = new URL(`${proto}://${host}/api/mcp-proxy`);
  proxyUrl.searchParams.set('target', mcpUrl);
  if (paymentToken) proxyUrl.searchParams.set('token', paymentToken);

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    defaultHeaders: { 'anthropic-beta': 'mcp-client-2025-04-04' },
  });

  const resp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM,
    messages,
    mcp_servers: [
      { type: 'url', url: proxyUrl.toString(), name: 'mcp-server' },
    ],
  });

  return {
    content: resp.content.flatMap((b) => {
      if (b.type === 'text') return [{ type: 'text', text: b.text }];
      if (b.type === 'mcp_tool_use') return [{ type: 'tool_use', name: b.name, input: b.input }];
      if (b.type === 'mcp_tool_result') {
        const text = (b.content || [])
          .map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
          .join('\n');
        return [{ type: 'tool_result', name: '', content: text }];
      }
      return [];
    }),
  };
}

// ── OpenAI ────────────────────────────────────────────────────────────────────
async function handleOpenAI(messages, mcpUrl, paymentToken) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const mcpTools = await discoverTools(mcpUrl, paymentToken);

  const tools = mcpTools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema || { type: 'object', properties: {} },
    },
  }));

  const msgs = [
    { role: 'system', content: SYSTEM },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  const blocks = [];

  for (let i = 0; i < 5; i++) {
    const resp = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 4096,
      messages: msgs,
      tools: tools.length ? tools : undefined,
    });

    const msg = resp.choices[0].message;
    msgs.push(msg);

    if (msg.content) blocks.push({ type: 'text', text: msg.content });
    if (!msg.tool_calls?.length) break;

    for (const tc of msg.tool_calls) {
      const args = JSON.parse(tc.function.arguments || '{}');
      blocks.push({ type: 'tool_use', name: tc.function.name, input: args });

      const result = await invokeTool(mcpUrl, tc.function.name, args, paymentToken);
      const resultText = result.map((c) => c.text ?? JSON.stringify(c)).join('\n');
      blocks.push({ type: 'tool_result', name: tc.function.name, content: resultText });

      msgs.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
    }
  }

  return { content: blocks, tools: mcpTools.length };
}

// ── Gemini ────────────────────────────────────────────────────────────────────
async function handleGemini(messages, mcpUrl, paymentToken) {
  const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
  const mcpTools = await discoverTools(mcpUrl, paymentToken);

  const functionDeclarations = mcpTools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema || { type: 'object', properties: {} },
  }));

  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const blocks = [];

  for (let i = 0; i < 5; i++) {
    const resp = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents,
      config: {
        systemInstruction: SYSTEM,
        tools: functionDeclarations.length ? [{ functionDeclarations }] : undefined,
      },
    });

    const parts = resp.candidates?.[0]?.content?.parts ?? [];
    contents.push({ role: 'model', parts });

    let hasFunctionCall = false;
    const fnResponses = [];

    for (const part of parts) {
      if (part.text) blocks.push({ type: 'text', text: part.text });
      if (part.functionCall) {
        hasFunctionCall = true;
        const { name, args } = part.functionCall;
        blocks.push({ type: 'tool_use', name, input: args });

        const result = await invokeTool(mcpUrl, name, args, paymentToken);
        const resultText = result.map((c) => c.text ?? JSON.stringify(c)).join('\n');
        blocks.push({ type: 'tool_result', name, content: resultText });

        fnResponses.push({ functionResponse: { name, response: { output: resultText } } });
      }
    }

    if (!hasFunctionCall) break;
    contents.push({ role: 'user', parts: fnResponses });
  }

  return { content: blocks, tools: mcpTools.length };
}

// ── Entry point ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const messages = Array.isArray(payload?.messages) ? payload.messages : null;
  if (!messages) return res.status(400).json({ error: 'Missing messages array' });

  const mcpUrl = payload.mcpUrl;
  if (!mcpUrl) return res.status(400).json({ error: 'Missing mcpUrl' });

  const paymentToken = payload.paymentToken || undefined;
  const provider = payload.provider || 'anthropic';

  const keyMap = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    gemini: 'GOOGLE_API_KEY',
  };

  if (!keyMap[provider]) return res.status(400).json({ error: `Unknown provider: ${provider}` });
  if (!process.env[keyMap[provider]])
    return res.status(500).json({ error: `${keyMap[provider]} is not configured` });

  try {
    let result;
    if (provider === 'anthropic') result = await handleAnthropic(messages, req, mcpUrl, paymentToken);
    else if (provider === 'openai') result = await handleOpenAI(messages, mcpUrl, paymentToken);
    else result = await handleGemini(messages, mcpUrl, paymentToken);

    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Request failed' });
  }
}
