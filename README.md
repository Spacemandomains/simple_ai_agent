# simple_ai_agent

Simple AI Agent with **machine-to-machine (M2M) Stripe payments** for paid MCP tools. The agent autonomously pays the MCP server whenever it calls a tool that returns `402 Payment Required`, using a pre-configured Stripe customer and saved payment method.

## Stack

- Static HTML chat UI (no framework)
- Vercel Node.js serverless functions
- `@anthropic-ai/sdk` · `openai` · `@google/genai`
- Selectable provider: **Anthropic** (`claude-sonnet-4-6`), **OpenAI** (`gpt-4o`), **Google Gemini** (`gemini-2.0-flash`)
- Stripe REST API (no SDK) — Stripe itself is the ledger

## Architecture

```
browser ──► /api/chat ──► Anthropic API  (native mcp_servers)
                     │         │
                     │         ▼
                     │    /api/mcp-proxy ──► <your MCP server>/mcp
                     │
                     ├──► OpenAI API  (manual tool loop)
                     │         │
                     └──► Gemini API  (manual tool loop)
                               │
                               ▼  (both)
                          /api/mcp-client.js  ──► <your MCP server>/mcp

                          on 402 response:
                                ▼
                          /lib/wallet.js  ──► Stripe /payment_intents/:id/confirm
                                              (off_session, saved payment_method)
```

## M2M payment flow

1. Agent calls a paid MCP tool.
2. MCP server returns `402` with a Stripe `PaymentIntent` id.
3. `api/chat.js` → `callTool()` catches the 402 and calls `lib/wallet.js` → `confirmPayment()`.
4. Wallet enforces **per-call** and **daily** spend limits, then confirms the PaymentIntent off-session using the customer's saved payment method.
5. Agent retries the tool call with the now-paid `payment_intent_id` as `X-Payment-Token`. MCP returns the result.
6. Every wallet charge is tagged `metadata.wallet = "agent"` in Stripe, so the ledger is queryable: the `/api/wallet/status` endpoint sums the last 24 h of agent-tagged PaymentIntents.

All of this happens server-side with no user interaction.

## Files

| File | Purpose |
|---|---|
| `index.html` | Chat UI + live wallet balance bar |
| `api/chat.js` | Routes requests, runs tool-call loop, auto-pays 402s |
| `api/mcp-proxy.js` | Forwards MCP traffic for Anthropic's `mcp_servers` |
| `api/mcp-client.js` | Server-side MCP JSON-RPC client for OpenAI/Gemini |
| `api/wallet/status.js` | `GET` — wallet balance, limits, recent charges |
| `api/wallet/charge.js` | `POST` — confirm a specific PaymentIntent |
| `api/wallet/verify.js` | `GET` — verify a PaymentIntent status |
| `lib/wallet.js` | Stripe wallet: limits, confirm off_session, ledger queries |

## Deploy to Vercel

1. Import this repo (no framework preset — Vercel auto-detects `api/*` and serves `index.html`).
2. Set environment variables.

### Required — LLM providers (set at least one)

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `GOOGLE_API_KEY` | Google AI Studio API key |

### Required — Stripe M2M wallet

| Variable | Description |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_...` or `sk_test_...`) |
| `STRIPE_CUSTOMER_ID` | Your Stripe customer id (`cus_...`) that the agent charges |
| `STRIPE_PAYMENT_METHOD_ID` | Saved payment method on that customer (`pm_...`). Optional if the customer has a default `invoice_settings.default_payment_method`. |

> The payment method must be **reusable off-session** (e.g. a card saved with `setup_future_usage=off_session` or attached via a SetupIntent). Stripe will reject off-session confirmations otherwise.

### Optional — spend limits

| Variable | Default | Description |
|---|---|---|
| `WALLET_DAILY_LIMIT_CENTS` | `500` ($5.00) | Max total spend over the last 24 h |
| `WALLET_PER_CALL_LIMIT_CENTS` | `200` ($2.00) | Max spend on any single tool call |

Charges above either limit are rejected before hitting Stripe and surfaced to the UI as `wallet_error`.

## Connecting your own Stripe customer

You already have a customer + payment method. To wire them into the agent:

```bash
# in Vercel dashboard → Project → Settings → Environment Variables
STRIPE_SECRET_KEY=sk_live_...
STRIPE_CUSTOMER_ID=cus_...            # your customer
STRIPE_PAYMENT_METHOD_ID=pm_...       # reusable, attached to that customer
```

Redeploy. The agent will now auto-pay any `402` from the MCP server, up to the configured daily and per-call caps.

## Local dev

```bash
npm install
npx vercel dev
```

Create `.env.local` with the same variables.

## Safety notes

- The daily and per-call limits are the only backstops against a runaway agent. Set them conservatively.
- Use a **restricted Stripe key** with only PaymentIntents read/write scope.
- The default payment method resolution (`invoice_settings.default_payment_method`) is only used when `STRIPE_PAYMENT_METHOD_ID` is unset; prefer setting it explicitly so a Stripe dashboard change can't silently swap what the agent charges.
