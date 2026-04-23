import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { discoverTools, invokeTool } from './mcp-client.js';

export const config = { runtime: 'nodejs' };

const SYSTEM =
  'You are a helpful assistant with access to tools provided by an MCP server. ' +
  'Use the available tools to answer questions accurately and concisely.';

// Confirm a Stripe payment intent server-side using saved credentials.
// Returns the confirmed payment intent ID, or null if not configured / needs frontend.
async function autoConfirmPayment(paymentData) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const paymentMethodId = process.env.STRIPE_PAYMENT_METHOD_ID;
  if (!secretKey || !paymentMethodId) return null;

  const pi = paymentData.payment_methods?.stripe_per_call?.payment_intent;
  if (!pi?.id) return null;

  const r = await fetch(`https://api.stripe.com/v1/payment_intents/${pi.id}/confirm`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      payment_method: paymentMethodId,
      off_session: 'true',
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(`Stripe: ${err.error?.message || `HTTP ${r.status}`}`);
  }

  const intent = await r.json();
  return intent.status === 'succeeded' ? intent.id : null;
}

// Invoke a tool, auto-paying any 402 if server credentials are configured.
// Returns { ok, content } on success or { ok: false, paymentRequired } for frontend fallback.
async function callTool(mcpUrl, name, args, paymentToken) {
  try {
    return { ok: true, content: await invokeTool(mcpUrl, name, args, paymentToken) };
  } catch (err) {
    if (!err.paymentRequired) throw err;

    const confirmedToken = await autoConfirmPayment(err.paymentRequired);
    if (confirmedToken) {
      try {
        return { ok: true, content: await invokeTool(mcpUrl, name, args, confirmedToken) };
      } catch (retryErr) {
        if (retryErr.paymentRequired) return { ok: false, paymentRequired: retryErr.paymentRequired };
        throw retryErr;
      }
    }

    return { ok: false, paymentRequired: err.paymentRequired };
  }
}

// ── Anthropic ─────────────────────────────────────────────────────────────────
async function handleAnthropic(messages, mcpUrl, paymentToken) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const mcpTools = await discoverTools(mcpUrl, paymentToken);

  const tools = mcpTools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema || { type: 'object', properties: {} },
  }));

  const msgs = messages.map((m) => ({ role: m.role, content: m.content }));
  const blocks = [];

  for (let i = 0; i < 5; i++) {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM,
      messages: msgs,
      tools: tools.length ? tools : undefined,
    });

    for (const b of resp.content) {
      if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
    }

    const toolUses = resp.content.filter((b) => b.type === 'tool_use');
    if (!toolUses.length || resp.stop_reason === 'end_turn') break;

    msgs.push({ role: 'assistant', content: resp.content });

    const toolResults = [];
    for (const tu of toolUses) {
      blocks.push({ type: 'tool_use', name: tu.name, input: tu.input });
      const result = await callTool(mcpUrl, tu.name, tu.input, paymentToken);
      if (!result.ok) return { payment_required: true, ...result.paymentRequired };
      const text = result.content.map((c) => c.text ?? JSON.stringify(c)).join('\n');
      blocks.push({ type: 'tool_result', name: tu.name, content: text });
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: text });
    }
    msgs.push({ role: 'user', content: toolResults });
  }

  return { content: blocks, tools: mcpTools.length };
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
      const result = await callTool(mcpUrl, tc.function.name, args, paymentToken);
      if (!result.ok) return { payment_required: true, ...result.paymentRequired };
      const text = result.content.map((c) => c.text ?? JSON.stringify(c)).join('\n');
      blocks.push({ type: 'tool_result', name: tc.function.name, content: text });
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: text });
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
        const result = await callTool(mcpUrl, name, args, paymentToken);
        if (!result.ok) return { payment_required: true, ...result.paymentRequired };
        const text = result.content.map((c) => c.text ?? JSON.stringify(c)).join('\n');
        blocks.push({ type: 'tool_result', name, content: text });
        fnResponses.push({ functionResponse: { name, response: { output: text } } });
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
    if (provider === 'anthropic') result = await handleAnthropic(messages, mcpUrl, paymentToken);
    else if (provider === 'openai') result = await handleOpenAI(messages, mcpUrl, paymentToken);
    else result = await handleGemini(messages, mcpUrl, paymentToken);

    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Request failed' });
  }
}
