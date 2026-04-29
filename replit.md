# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Application: MCP Test Agent

Ported from Vercel. A chat UI for testing MCP (Model Context Protocol) servers using multiple AI providers (Anthropic, OpenAI, Google Gemini). Supports M2M Stripe payments for paid MCP tools.

### Architecture

```
browser ──► /api/chat ──► Anthropic / OpenAI / Gemini
                     │         │
                     │         ▼
                     │    /api/mcp-proxy ──► <your MCP server>/mcp
                     │
                     ├──► /api/wallet/status  — GET wallet balance
                     ├──► /api/wallet/charge  — POST confirm PaymentIntent
                     └──► /api/wallet/verify  — GET verify PaymentIntent
```

### Required Environment Variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `GOOGLE_API_KEY` | Google AI Studio API key |
| `STRIPE_SECRET_KEY` | Stripe secret key (for wallet) |
| `STRIPE_CUSTOMER_ID` | Stripe customer id for the agent wallet |
| `STRIPE_PAYMENT_METHOD_ID` | Saved payment method (optional if default set) |
| `DATABASE_URL` | PostgreSQL connection string (auto-set) |

### Optional Environment Variables

| Variable | Default | Description |
|---|---|---|
| `WALLET_DAILY_LIMIT_CENTS` | 500 | Max daily spend in cents |
| `WALLET_PER_CALL_LIMIT_CENTS` | 200 | Max per-call spend in cents |

### Key Files

- `artifacts/mcp-agent/` — React + Vite frontend (served at `/`)
- `artifacts/api-server/src/routes/chat.ts` — AI chat handler (Anthropic, OpenAI, Gemini)
- `artifacts/api-server/src/routes/mcp-proxy.ts` — MCP proxy for Anthropic's native mcp_servers
- `artifacts/api-server/src/routes/wallet.ts` — Stripe wallet endpoints
- `artifacts/api-server/src/lib/mcp-client.ts` — MCP JSON-RPC client with DB account persistence
- `artifacts/api-server/src/lib/wallet.ts` — Stripe wallet logic
