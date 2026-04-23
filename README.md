# simple_ai_agent

Simple AI Agent for testing the [Hawaii Conditions](https://hawaii-conditions.vercel.app/) MCP server.

## Stack

- Static HTML chat UI (no framework)
- Vercel Node.js serverless functions
- `@anthropic-ai/sdk` · `openai` · `@google/genai`
- Selectable provider: **Anthropic** (`claude-sonnet-4-6`), **OpenAI** (`gpt-4o`), **Google Gemini** (`gemini-2.0-flash`)

## Architecture

```
browser ──► /api/chat ──► Anthropic API  (native mcp_servers)
                     │         │
                     │         ▼
                     │    /api/mcp-proxy ──► hawaii-conditions.vercel.app/mcp
                     │
                     ├──► OpenAI API  (manual tool loop)
                     │         │
                     └──► Gemini API  (manual tool loop)
                               │
                               ▼  (both)
                          /api/mcp-client.js  ──► hawaii-conditions.vercel.app/mcp
```

- **Anthropic**: uses `mcp_servers` beta — Anthropic's cloud fetches tools and calls `/api/mcp-proxy`, which injects `X-Payment-Token`.
- **OpenAI / Gemini**: `api/mcp-client.js` discovers tools and runs a manual tool-call loop server-side, calling the Hawaii MCP directly with `X-Payment-Token`.

## Files

| File | Purpose |
|---|---|
| `index.html` | Chat UI with provider dropdown |
| `api/chat.js` | Routes requests to Anthropic, OpenAI, or Gemini |
| `api/mcp-proxy.js` | Forwards MCP traffic for Anthropic's `mcp_servers` |
| `api/mcp-client.js` | Server-side MCP JSON-RPC client for OpenAI/Gemini |
| `vercel.json` | 60 s function timeout |
| `package.json` | `@anthropic-ai/sdk`, `openai`, `@google/genai` |

## Deploy to Vercel

1. Import this repo (no framework preset — Vercel auto-detects `api/*` and serves `index.html`).
2. Set environment variables:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `GOOGLE_API_KEY` | Google AI Studio API key |
| `HAWAII_PAYMENT_TOKEN` | Stripe `payment_intent_id` for Hawaii MCP paid tools |

3. Deploy. Only the keys you set will work — unused providers return a clear error.

## Local dev

```bash
npm install
npx vercel dev
```

Create `.env.local` with the same variables.
