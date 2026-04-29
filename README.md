# MCP Test Agent

  A chat UI for testing MCP (Model Context Protocol) servers with AI providers (Anthropic, OpenAI, Gemini) and M2M Stripe payments for paid tools.

  ## Setup

  ### Environment Variables

  Add these to your Vercel project settings:

  | Variable | Required | Description |
  |---|---|---|
  | `ANTHROPIC_API_KEY` | For Anthropic | Anthropic API key |
  | `OPENAI_API_KEY` | For OpenAI | OpenAI API key |
  | `GOOGLE_API_KEY` | For Gemini | Google AI API key |
  | `DATABASE_URL` | Yes | PostgreSQL connection string |
  | `STRIPE_SECRET_KEY` | For payments | Stripe secret key |
  | `STRIPE_CUSTOMER_ID` | For payments | Stripe customer ID for the agent |
  | `STRIPE_PAYMENT_METHOD_ID` | Optional | Default payment method ID |
  | `WALLET_DAILY_LIMIT_CENTS` | Optional | Daily spend limit (default: 500¢) |
  | `WALLET_PER_CALL_LIMIT_CENTS` | Optional | Per-call limit (default: 200¢) |
  | `AGENT_ID` | Optional | Agent identifier (default: simple-ai-agent) |
  | `PAYMENT_PROVIDER` | Optional | Payment provider name (default: stripe) |

  ## Development

  ```bash
  npm install
  npm run dev
  ```

  ## Deploy

  Deploy to Vercel — it auto-detects the Vite frontend and the `api/` serverless functions.
  