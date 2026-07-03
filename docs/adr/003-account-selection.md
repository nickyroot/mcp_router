# ADR-003: Account selection — optional parameter plus session state

Status: Accepted

## Context

When the model calls a merged tool (`search_pages`) and multiple accounts
could serve it, how does the account get chosen? This was the most contested
decision in review, so both positions are recorded in full.

**Position A — session state only.** The model sees `search_pages(query)`
with no account parameter; the router exposes `switch_account` /
`current_account` management tools and routes by current state. Argument:
account selection is environment, not business logic — injecting `account`
into every tool is like adding `timezone` or `theme` to every API call.
The conversational flow ("Switch to Startup" → everything follows) is clean.

**Position B — optional parameter plus session state.** Every merged tool
gains an optional `account` property (enum of the configured account names);
session state supplies the default when the parameter is omitted.

## Why Position A alone was rejected

1. **Accounts are sometimes the intent, not the environment.** "Compare my
   personal roadmap against the startup one" needs two accounts in a single
   step. Pure modal state turns two parallel tool calls into
   switch → call → switch → call. `timezone` and `theme` never work this way —
   no request needs two of them at once. The analogy fails exactly where it
   matters.
2. **State is process-global over stdio** (ADR-006). Claude Desktop shares one
   router process across all conversations. If state is the *only* mechanism,
   switching accounts in chat A silently redirects chat B's writes — the
   precise failure ADR-000 forbids. The explicit parameter is the stateless
   escape hatch that keeps each individual call correct.
3. **The enum is free discovery.** `"enum": ["personal", "startup", "client"]`
   in the schema tells the model what exists at zero round-trip cost. Models
   are also empirically better at filling parameters than at tracking modal
   state across a long conversation.

## Decision

Both layers, mirroring `git config user.email` + `git commit --author`:

- Every merged tool gets an **optional** injected property:

  ```json
  "account": {
    "type": "string",
    "enum": ["personal", "startup", "client"],
    "description": "Which <provider> account to use. Omit to use the active account."
  }
  ```

  The router strips this property before forwarding the call downstream.
  Injection is legal: `inputSchema` is plain JSON Schema and downstream never
  sees the extra key.
- Session state (`switch_account`, and contexts per ADR-004/005) supplies the
  default when the parameter is omitted.
- Per-provider opt-out: `inject_account: false` for users who prefer pure
  state mode or run schema-sensitive clients. Choice, not doctrine.
- If neither parameter nor state resolves the route: ask (ADR-005).

## Validation (2026-07-02)

Observed in production (Claude Desktop, three live Notion accounts): given an
ambiguous search, the model neither asked nor guessed — it **fanned out
across all three accounts in parallel** and attributed results per workspace.
A third behavior, emergent from the enum being visible in the schema, and
structurally impossible under Position A (a session cannot be "switched to"
three accounts at once). The cross-account write test also passed: an
explicitly targeted page creation landed in the correct workspace.

## Consequences

- Schema noise: one extra optional property on every merged tool. Accepted;
  the opt-out flag exists for those who disagree.
- The stripped parameter must never leak downstream — a dedicated test
  asserts this, since a downstream server with strict validation would reject
  unknown keys.
- Reserved-name collision: if a downstream tool already defines `account`, we
  inject `router_account` instead for that tool and log a warning.
