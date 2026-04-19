# simple_ai_agent

Simple AI Agent for testing the [Hawaii Conditions](https://hawaii-conditions.vercel.app/) MCP server.

## Stack

- Static HTML chat UI (no framework)
- Vercel Node.js serverless functions
- `@anthropic-ai/sdk` calling `claude-sonnet-4-6`
- Anthropic [`mcp_servers`](https://docs.claude.com/en/docs/agents-and-tools/mcp-connector) connector to the Hawaii Conditions MCP

## Architecture

```
browser ──► /api/chat ──► Anthropic API
                              │
                              ▼ (mcp_servers)
                         /api/mcp-proxy ──► hawaii-conditions.vercel.app/mcp
                              ▲
                              └── injects X-Payment-Token header
```

The Hawaii Conditions MCP uses Stripe payment tokens for auth (`X-Payment-Token`
header), which Anthropic's `mcp_servers` connector cannot send directly. The
`/api/mcp-proxy` route forwards MCP traffic and adds the header from the
`HAWAII_PAYMENT_TOKEN` env var.

## Files

- `index.html` — chat UI
- `api/chat.js` — calls Claude with `mcp_servers` pointing at the proxy
- `api/mcp-proxy.js` — forwards MCP requests with `X-Payment-Token` header
- `vercel.json` — serverless function config
- `package.json` — declares `@anthropic-ai/sdk`

## Deploy

1. Import this repo into Vercel (no framework — Vercel auto-detects `api/*` and serves `index.html` statically).
2. Set environment variables in the Vercel project:
   - `ANTHROPIC_API_KEY` — your Anthropic API key
   - `HAWAII_PAYMENT_TOKEN` — Stripe `payment_intent_id` for the Hawaii MCP (paid tools won't work without this)
3. Deploy.

## Local dev

```bash
npm install
npx vercel dev
```

Set the same env vars in `.env.local`.
