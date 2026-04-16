# pi-psst

A [pi](https://github.com/badlogic/pi-mono) extension for [psst](https://github.com/Michaelliv/psst) — automatic secret injection and scrubbing for AI agents.

## What it does

- **Injects** psst vault secrets as environment variables into every bash command
- **Scrubs** secret values from all tool output — bash, read, grep, everything the LLM sees
- **Tells** the LLM which secrets are available via the system prompt
- **Never** exposes secret values to the agent's context

```
You: "deploy using the stripe key"

Agent runs: curl -H "Authorization: Bearer $STRIPE_KEY" https://api.stripe.com
Agent sees: HTTP 200 OK, Authorization: Bearer [REDACTED:STRIPE_KEY]
```

## Install

```bash
# Requires psst-cli
npm install -g psst-cli

# Install the extension
pi install npm:@miclivs/pi-psst
# or
pi install git:github.com/Michaelliv/pi-psst
```

## Setup

```bash
# Create a vault and add secrets
psst init
psst set STRIPE_KEY
psst set DATABASE_URL

# Start pi — secrets are automatically available
pi
```

## Commands

| Command | Description |
|---------|-------------|
| `/psst` | List loaded secret names |
| `/psst-set NAME [value]` | Add or update a secret |

## How it works

1. On each bash call, the extension reads secrets from the local psst vault via the SDK
2. Secrets are injected into the subprocess environment via `spawnHook`
3. After any tool completes, `tool_result` scrubs secret values from the output
4. `before_agent_start` adds secret names to the system prompt so the LLM knows to use `$SECRET_NAME`

The agent orchestrates. psst handles the secrets. The values never touch the context window.

## License

MIT
