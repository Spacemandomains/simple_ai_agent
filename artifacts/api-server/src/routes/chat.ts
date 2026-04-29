import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { discoverTools, invokeTool } from '../lib/mcp-client.js';

const router = Router();

function buildSystemPrompt(): string {
  const lines: string[] = [
    'You are a helpful assistant with access to tools provided by an MCP server.',
    'Use the available tools to answer questions accurately and concisely.',
    '',
    'AGENT ENVIRONMENT — use these values automatically whenever the MCP server asks for registration or payment information:',
  ];

  const agentId = process.env.AGENT_ID || process.env.REPLIT_DEPLOYMENT_KEY || 'simple-ai-agent';
  const displayName = process.env.HAWAII_CONDITIONS_AGENT_NAME || 'Hawaii Conditions User';
  const paymentProvider = process.env.PAYMENT_PROVIDER || 'stripe';

  lines.push(`- agent_id: ${agentId}`);
  lines.push(`- display_name: ${displayName}`);
  lines.push(`- payment_provider: ${paymentProvider}`);

  if (process.env.STRIPE_CUSTOMER_ID) {
    lines.push(`- stripe_customer_id: ${process.env.STRIPE_CUSTOMER_ID}`);
    lines.push(`- provider_customer_id: ${process.env.STRIPE_CUSTOMER_ID}`);
  }

  lines.push('');
  lines.push(
    'When registering with an MCP server (e.g. via a register_agent tool), ' +
    'always pass the values above — do not ask the user for them. ' +
    'When a tool returns a payment_required or setup_required response, ' +
    'use the stripe_customer_id above for the payment identity. ' +
    'The server-side wallet will handle the actual payment confirmation automatically.'
  );

  return lines.join('\n');
}

async function payViaWallet(paymentData: Record<string, unknown>) {
  if ((paymentData as any).status === 'setup_required' || (paymentData as any).setup_intent_id) {
    const err = new Error(
      'Wallet setup is required. Confirm this SetupIntent once using the returned client_secret and publishable_key. ' +
      'After setup, future add_funds calls can be confirmed off-session automatically by the MCP server.'
    );
    (err as any).walletError = 'SETUP_INTENT_REQUIRED';
    (err as any).tool = (paymentData as any).tool || 'create_wallet_setup';
    (err as any).setup_intent_id = (paymentData as any).setup_intent_id;
    (err as any).client_secret = (paymentData as any).client_secret;
    (err as any).publishable_key = (paymentData as any).publishable_key;
    (err as any).stripe_customer_id = (paymentData as any).stripe_customer_id;
    (err as any).raw_payment_required = (paymentData as any).raw || paymentData;
    throw err;
  }

  const stripePerCall = (paymentData as any).payment_methods?.stripe_per_call;
  const pi = stripePerCall?.payment_intent;

  if (!pi?.id) {
    const err = new Error('402 response contained no Stripe payment_intent id');
    (err as any).walletError = 'NO_PAYMENT_INTENT';
    (err as any).raw_payment_required = (paymentData as any).raw || paymentData;
    throw err;
  }

  const err = new Error(
    'This PaymentIntent was created by the MCP server Stripe account. ' +
    'The AI Agent cannot confirm it using its own Stripe secret key. ' +
    'Confirm it through the returned client_secret/publishable_key flow, Stripe Connect, or a supported MPP wallet.'
  );
  (err as any).walletError = 'CROSS_ACCOUNT_PAYMENT_INTENT';
  (err as any).payment_intent_id = pi.id;
  (err as any).client_secret = pi.client_secret;
  (err as any).publishable_key = stripePerCall?.publishable_key;
  (err as any).amount_cents = (paymentData as any).amount_cents;
  (err as any).price = (paymentData as any).price_usd;
  (err as any).currency = (paymentData as any).currency || 'usd';
  (err as any).tool = (paymentData as any).tool;
  (err as any).raw_payment_required = (paymentData as any).raw || paymentData;
  throw err;
}

async function callToolSafe(mcpUrl: string, name: string, args: Record<string, unknown>, paymentToken: string | undefined) {
  try {
    return { ok: true, content: await invokeTool(mcpUrl, name, args, paymentToken) };
  } catch (err: any) {
    if (!err.paymentRequired) throw err;

    let confirmedToken: unknown;
    try {
      confirmedToken = await payViaWallet(err.paymentRequired);
    } catch (walletErr: any) {
      return {
        ok: false,
        walletError: {
          code: walletErr.code || walletErr.walletError || 'WALLET_ERROR',
          message: walletErr.message,
          tool: walletErr.tool || err.paymentRequired.tool,
          price: walletErr.price || err.paymentRequired.price_usd,
          currency: walletErr.currency || err.paymentRequired.currency,
          setup_intent_id: walletErr.setup_intent_id,
          stripe_customer_id: walletErr.stripe_customer_id,
          payment_intent_id: walletErr.payment_intent_id,
          client_secret: walletErr.client_secret,
          publishable_key: walletErr.publishable_key,
          raw_payment_required: walletErr.raw_payment_required,
          daily_spend_cents: walletErr.daily_spend_cents,
          daily_limit_cents: walletErr.daily_limit_cents,
          per_call_limit_cents: walletErr.per_call_limit_cents,
          amount_cents: walletErr.amount_cents,
        },
      };
    }

    try {
      return { ok: true, content: await invokeTool(mcpUrl, name, args, confirmedToken as string) };
    } catch (retryErr: any) {
      if (retryErr.paymentRequired) return { ok: false, paymentRequired: retryErr.paymentRequired };
      throw retryErr;
    }
  }
}

function finalizeFailure(result: Record<string, unknown>, blocks: unknown[], toolsCount: number) {
  if ((result as any).walletError) {
    blocks.push({ type: 'text', text: JSON.stringify({ wallet_error: (result as any).walletError }, null, 2) });
    return { content: blocks, tools: toolsCount, wallet_error: (result as any).walletError };
  }
  return { content: blocks, tools: toolsCount, payment_required: true, ...(result as any).paymentRequired };
}

async function handleAnthropic(messages: unknown[], mcpUrl: string, paymentToken: string | undefined) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const mcpTools = await discoverTools(mcpUrl, paymentToken);

  const tools = mcpTools.map((t: any) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema || { type: 'object', properties: {} },
  }));

  const msgs = (messages as any[]).map((m) => ({ role: m.role, content: m.content }));
  const blocks: unknown[] = [];

  for (let i = 0; i < 5; i++) {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: buildSystemPrompt(),
      messages: msgs as any,
      tools: tools.length ? tools as any : undefined,
    });

    for (const b of resp.content) {
      if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
    }

    const toolUses = resp.content.filter((b) => b.type === 'tool_use');
    if (!toolUses.length || resp.stop_reason === 'end_turn') break;

    msgs.push({ role: 'assistant', content: resp.content });

    const toolResults: unknown[] = [];
    for (const tu of toolUses as any[]) {
      blocks.push({ type: 'tool_use', name: tu.name, input: tu.input });
      const result = await callToolSafe(mcpUrl, tu.name, tu.input, paymentToken);
      if (!result.ok) return finalizeFailure(result as Record<string, unknown>, blocks, mcpTools.length);
      const text = (result.content as any[]).map((c: any) => c.text ?? JSON.stringify(c)).join('\n');
      blocks.push({ type: 'tool_result', name: tu.name, content: text });
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: text });
    }
    msgs.push({ role: 'user', content: toolResults });
  }

  return { content: blocks, tools: mcpTools.length };
}

async function handleOpenAI(messages: unknown[], mcpUrl: string, paymentToken: string | undefined) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const mcpTools = await discoverTools(mcpUrl, paymentToken);

  const tools = mcpTools.map((t: any) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: 'object', properties: {} } },
  }));

  const msgs: any[] = [
    { role: 'system', content: buildSystemPrompt() },
    ...(messages as any[]).map((m) => ({ role: m.role, content: m.content })),
  ];
  const blocks: unknown[] = [];

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
      const result = await callToolSafe(mcpUrl, tc.function.name, args, paymentToken);
      if (!result.ok) return finalizeFailure(result as Record<string, unknown>, blocks, mcpTools.length);
      const text = (result.content as any[]).map((c: any) => c.text ?? JSON.stringify(c)).join('\n');
      blocks.push({ type: 'tool_result', name: tc.function.name, content: text });
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: text });
    }
  }

  return { content: blocks, tools: mcpTools.length };
}

async function handleGemini(messages: unknown[], mcpUrl: string, paymentToken: string | undefined) {
  const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
  const mcpTools = await discoverTools(mcpUrl, paymentToken);

  const functionDeclarations = mcpTools.map((t: any) => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema || { type: 'object', properties: {} },
  }));

  const contents = (messages as any[]).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const blocks: unknown[] = [];

  for (let i = 0; i < 5; i++) {
    const resp = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents,
      config: {
        systemInstruction: buildSystemPrompt(),
        tools: functionDeclarations.length ? [{ functionDeclarations }] : undefined,
      } as any,
    });

    const parts = (resp as any).candidates?.[0]?.content?.parts ?? [];
    contents.push({ role: 'model', parts });

    let hasFunctionCall = false;
    const fnResponses: unknown[] = [];

    for (const part of parts) {
      if (part.text) blocks.push({ type: 'text', text: part.text });
      if (part.functionCall) {
        hasFunctionCall = true;
        const { name, args } = part.functionCall;
        blocks.push({ type: 'tool_use', name, input: args });
        const result = await callToolSafe(mcpUrl, name, args, paymentToken);
        if (!result.ok) return finalizeFailure(result as Record<string, unknown>, blocks, mcpTools.length);
        const text = (result.content as any[]).map((c: any) => c.text ?? JSON.stringify(c)).join('\n');
        blocks.push({ type: 'tool_result', name, content: text });
        fnResponses.push({ functionResponse: { name, response: { output: text } } });
      }
    }

    if (!hasFunctionCall) break;
    contents.push({ role: 'user', parts: fnResponses });
  }

  return { content: blocks, tools: mcpTools.length };
}

router.post('/chat', async (req, res) => {
  const payload = req.body;
  const messages = Array.isArray(payload?.messages) ? payload.messages : null;
  if (!messages) return res.status(400).json({ error: 'Missing messages array' });

  const mcpUrl = payload.mcpUrl;
  if (!mcpUrl) return res.status(400).json({ error: 'Missing mcpUrl' });

  const paymentToken = payload.paymentToken || undefined;
  const provider = payload.provider || 'anthropic';

  const keyMap: Record<string, string> = {
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
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Request failed' });
  }
});

export default router;
