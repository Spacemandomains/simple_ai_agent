import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { discoverTools, invokeTool } from './mcp-client.js';

export const config = { runtime: 'nodejs' };

const SYSTEM =
  'You are a helpful assistant with access to tools provided by an MCP server. ' +
  'Use the available tools to answer questions accurately and concisely.';

// MCP-created PaymentIntents live in the MCP server's Stripe account.
// This AI Agent cannot confirm them with its own Stripe secret key.
// Return the MCP payment details so a compatible client/wallet/MPP layer can confirm using client_secret + publishable_key.
async function payViaWallet(paymentData) {
  const stripePerCall = paymentData.payment_methods?.stripe_per_call;
  const pi = stripePerCall?.payment_intent;

  if (!pi?.id) {
    const err = new Error('402 response contained no Stripe payment_intent id');
    err.walletError = 'NO_PAYMENT_INTENT';
    throw err;
  }

  const err = new Error(
    'This PaymentIntent was created by the MCP server Stripe account. ' +
    'The AI Agent cannot confirm it using its own Stripe secret key. ' +
    'Confirm it through the returned client_secret/publishable_key flow, Stripe Connect, or a supported MPP wallet.'
  );

  err.walletError = 'CROSS_ACCOUNT_PAYMENT_INTENT';
  err.payment_intent_id = pi.id;
  err.client_secret = pi.client_secret;
  err.publishable_key = stripePerCall?.publishable_key;
  err.amount_cents = paymentData.amount_cents;
  err.price = paymentData.price_usd;
  err.currency = paymentData.currency || 'usd';
  err.tool = paymentData.tool;
  err.raw_payment_required = paymentData.raw || paymentData;

  throw err;
}

// Invoke a tool, surfacing any payment request without trying cross-account secret-key confirmation.
// Returns { ok, content } or { ok: false, walletError } / { ok: false, paymentRequired }.
async function callTool(mcpUrl, name, args, paymentToken) {
  try {
    return { ok: true, content: await invokeTool(mcpUrl, name, args, paymentToken) };
  } catch (err) {
    if (!err.paymentRequired) throw err;

    let confirmedToken;
    try {
      confirmedToken = await payViaWallet(err.paymentRequired);
    } catch (walletErr) {
      return {
        ok: false,
        walletError: {
          code:    walletErr.code || walletErr.walletError || 'WALLET_ERROR',
          message: walletErr.message,
          tool:    walletErr.tool || err.paymentRequired.tool,
          price:   walletErr.price || err.paymentRequired.price_usd,
          currency: walletErr.currency || err.paymentRequired.currency,
          payment_intent_id: walletErr.payment_intent_id,
          client_secret: walletErr.client_secret,
          publishable_key: walletErr.publishable_key,
          raw_payment_required: walletErr.raw_payment_required,
          daily_spend_cents:    walletErr.daily_spend_cents,
          daily_limit_cents:    walletErr.daily_limit_cents,
          per_call_limit_cents: walletErr.per_call_limit_cents,
          amount_cents:         walletErr.amount_cents,
        },
      };
    }

    try {
      return { ok: true, content: await invokeTool(mcpUrl, name, args, confirmedToken) };
    } catch (retryErr) {
      if (retryErr.paymentRequired) return { ok: false, paymentRequired: retryErr.paymentRequired };
      throw retryErr;
    }
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
      if (!result.ok) return finalizeFailure(result, blocks, mcpTools.length);
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
      if (!result.ok) return finalizeFailure(result, blocks, mcpTools.length);
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
        if (!result.ok) return finalizeFailure(result, blocks, mcpTools.length);
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

function finalizeFailure(result, blocks, toolsCount) {
  if (result.walletError) {
    return { content: blocks, tools: toolsCount, wallet_error: result.walletError };
  }
  return { content: blocks, tools: toolsCount, payment_required: true, ...result.paymentRequired };
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
  const provider     = payload.provider     || 'anthropic';

  const keyMap = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai:    'OPENAI_API_KEY',
    gemini:    'GOOGLE_API_KEY',
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
