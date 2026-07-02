# ADR-007: Downstream servers come from explicit config

Status: Accepted

## Context

How does the router learn which downstream servers exist? Options ranged from
fully explicit configuration to scanning the machine for installed MCP
servers or reading other clients' config files at runtime.

Auto-discovery is seductive and was listed as a stretch goal in the original
spec. But runtime magic in an identity-routing tool breeds exactly the wrong
kind of surprise: a server you forgot about silently becoming routable, or a
scan picking up a server authenticated as the wrong account. Discovery
errors here are not inconveniences — they are misrouted credentials.

## Decision

The config file (ADR-004) is the single source of truth. The router connects
to exactly the servers listed, nothing else. Providers "register" by being
present in config — there is no plugin registration API, no code changes in
the router core to add a provider (this answers the "how do providers
register?" question: they don't; they're declared).

Discovery convenience lives at **setup time, not runtime**:

- `router init` offers to import from `claude_desktop_config.json` (same
  `command/args/env` shape, per ADR-004), turning each existing entry into a
  provider/account with one confirmation each.
- `router validate` checks that every configured command exists on `PATH`
  and that referenced secrets resolve — catching drift before `router run`.

## Consequences

- Adding an account is a config edit plus restart in v0.1. Hot reload is a
  possible later convenience (watch file, diff, reconnect changed accounts);
  it changes no architecture because the downstream manager already supports
  connect/disconnect at runtime for crash recovery (ADR-006).
- No runtime scanning means no permission prompts, no false positives, and
  the security story stays one sentence long: "the router talks to what you
  told it to talk to."
- The import path makes onboarding nearly free for the target audience,
  which removes most of the demand that auto-discovery was meant to serve.
