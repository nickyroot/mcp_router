# ADR-009: Secrets are references, never values

Status: Accepted

## Context

Every account needs a credential (API token, OAuth token) passed to its
downstream server, almost always via environment variable. The config file is
the natural place to wire this — and the worst possible place to store the
actual values: it gets committed to dotfiles repos, pasted into issues, and
shared as "here's my setup."

The router is explicitly **not** an authentication service (ADR-013): it does
not mint, refresh, or host OAuth flows. It only delivers existing secrets to
child processes.

## Decision

The config's `env` values support reference syntax, resolved at server spawn
time:

```yaml
env:
  NOTION_TOKEN: ${keychain:notion-startup}   # OS keychain, service "mcp-router"
  GITHUB_TOKEN: ${env:GITHUB_WORK_TOKEN}     # router's own environment
  SLACK_TOKEN:  literal-value                # allowed, but warned about
```

- `${keychain:name}` — resolved via the OS credential store (macOS Keychain,
  Windows Credential Manager, libsecret) through `@napi-rs/keyring`
  (prebuilt binaries, no node-gyp). `router secret set <name>` /
  `router secret rm <name>` manage entries so users never touch Keychain UIs.
- `${env:NAME}` — resolved from the router process environment.
- Literal values work (zero-friction first run) but `router validate` emits a
  warning for anything that looks like a secret in plaintext.

Resolution happens lazily at spawn, held only in the child's environment;
secrets never appear in logs, error messages, `router stats`, or validation
output (values are redacted to `***` everywhere they might surface).

## Consequences

- One native dependency enters the budget (ADR-001). If keyring installation
  fails on an exotic platform, `${env:}` and literals still work — keychain
  is the recommended path, not a hard requirement.
- Unresolvable references are a **spawn-time** error for that account only:
  the account is marked unavailable with a clear message; sibling accounts
  keep working (ADR-006's degradation rule).
- OAuth-flow hosting stays out of scope. Downstream servers that manage their
  own OAuth (opening a browser on first run) work unchanged — the router
  just spawns them; their token cache is their business.
