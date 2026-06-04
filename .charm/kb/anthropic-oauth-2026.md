---
id: anthropic-oauth-2026
root: decisions
type: decision
status: current
summary: "As of mid-2026, Anthropic offers no OAuth delegation flow for third-party apps — API keys are the only sanctioned method; subscription OAuth was explicitly banned in Feb 2026."
created: 2026-06-04
updated: 2026-06-04
---

# Anthropic OAuth for Third-Party Apps — Mid-2026 Status

## Bottom line

**No sanctioned OAuth delegation exists.** A third-party web app cannot authorize users via an "Authorize with Anthropic" flow and then make API calls billed to the user's Anthropic account. This gap is explicitly acknowledged in Anthropic's ecosystem. API keys are the only supported authentication method for third-party integrations.

---

## What "OAuth" means in Anthropic's ecosystem (three distinct things)

### 1. Claude Code / claude.ai session OAuth (consumer-only)
Claude.ai and Claude Code use OAuth tokens internally for their own sessions. These tokens are:
- **Banned** from use in third-party apps as of January 9, 2026 (server-side enforcement), formally documented February 19, 2026
- Restricted to Claude Code CLI, Claude.ai web UI, and Claude's own official desktop/IDE extensions
- Using a subscription OAuth token in any external tool violates Anthropic's Consumer Terms of Service

### 2. Workload Identity Federation (M2M only — not user-delegated)
Anthropic added machine-to-machine credential federation: a server-side workload (AWS IAM role, GCP service account, GitHub Actions OIDC, Kubernetes service account, Okta, SPIFFE, etc.) can exchange its platform-issued JWT at `POST /v1/oauth/token` for a short-lived Anthropic API access token. This:
- Eliminates static `sk-ant-api...` keys for server deployments
- Is **not** a user-delegated OAuth flow — the workload identity is the principal, not an end user
- Requires creating a service account, federation issuer, and federation rule in the Claude Console
- Has no concept of user consent, authorization codes, or per-user billing
- Relevant for our own backend infra; not a path for letting users authorize access to their personal accounts

### 3. MCP connector OAuth (Claude as client, not provider)
Anthropic's MCP infrastructure supports OAuth 2.1 + PKCE — but **Claude is the OAuth client**, not the provider. The flow is:
- Claude connects to *your* MCP server/API
- Your MCP server can require OAuth, where Claude performs the PKCE flow against *your* identity provider (Google, GitHub, Auth0, etc.)
- Callback URL: `https://claude.ai/api/mcp/auth_callback` (Claude surfaces); `http://localhost/callback` (Claude Code)
- Scopes are defined by your server's Protected Resource Metadata
- Anthropic is not issuing tokens; your IdP is
- This is how Anthropic connects Claude to external services (Google Drive, GitHub), not how third-party apps connect to Anthropic

---

## Subscription vs. API — what changed in early/mid-2026

| Period | Status |
|---|---|
| Before Jan 2026 | Third-party tools (OpenClaw, OpenCode, etc.) could proxy subscription credentials via OAuth tokens |
| Jan 9, 2026 | Anthropic deployed server-side blocks; subscription tokens stopped working outside official clients |
| Feb 19, 2026 | Formally codified in Consumer Terms of Service: subscription OAuth restricted to Claude Code and claude.ai only |
| Jun 15, 2026 | Agent SDK + `claude -p` + Claude Code GitHub Actions exit subscription pools entirely; move to per-user monthly credit at API rates (Pro: $20, Max 5x: $100, Max 20x: $200; no rollover; hard ceiling by default) |

**Claude.ai Pro/Max subscribers cannot authorize third-party apps to draw from their subscription.** There is no sanctioned bridge between subscription access and third-party API use.

---

## Architecture implication

**Third-party apps must use API keys.** The user flow is:
1. User goes to `https://console.anthropic.com/settings/keys`
2. Generates an API key (billed to their account)
3. Pastes the key into the third-party app

This is the only Anthropic-sanctioned path. There is no "Sign in with Anthropic" or OAuth consent screen where a user authorizes the app and billing flows automatically.

**Why:** Anthropic acknowledges the gap explicitly. As of June 2026 there is no timeline for a first-party OAuth delegation product. The absence is structural — Anthropic has so far treated the API as a developer B2B product (developers hold keys, bill their own customers) rather than a consumer identity provider.

---

## Comparison to other AI providers

- **OpenAI**: Same situation — no user-delegated OAuth for third-party API billing
- **Google (Gemini)**: Has Google OAuth but API billing is separate from consumer accounts
- The absence is industry-wide, not Anthropic-specific

---

## Sources verified

- Anthropic platform docs: `platform.claude.com/docs/en/manage-claude/authentication` (API keys + WIF — no third-party OAuth)
- Anthropic ban announcement (Feb 19, 2026): Consumer Terms update banning subscription OAuth in third-party tools
- MCP connector OAuth (May 2026): Claude as OAuth client, not provider — `support.anthropic.com/en/articles/11175166`
- Agent SDK credit pool change (June 15, 2026): `techtimes.com/articles/317625/20260602/...`
- Analysis of structural gap: `medium.com/@em.mcconnell/the-missing-piece-in-anthropics-ecosystem-third-party-oauth-...`
