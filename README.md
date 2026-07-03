# MCP Router

> One MCP server. Unlimited accounts. *(working title — see naming note below)*

MCP Router is a local-first, open-source MCP server that sits between an AI
client (Claude Desktop, Cursor, …) and your other MCP servers, and solves one
problem exceptionally well: **multiple accounts per provider** — three Notion
workspaces, two GitHub identities, several Slack teams — through a single
MCP endpoint, with account selection that feels native to the model.

```
Claude Desktop
      │  MCP
      ▼
  MCP Router ──► Notion (personal)
      │      ──► Notion (startup)
      │      ──► GitHub (company)
      └────────► ...
```

## Design philosophy

> Invisible plumbing, visible decisions. The router presents the model with a
> single coherent identity layer; the machinery stays hidden, but which
> account a request was routed to — especially a write — is always visible.

## Status

**v0.2.** v0.1 was validated in production (Claude Desktop, three live Notion
workspaces — see the ADR-003 validation note). Architecture is recorded in
[docs/adr](docs/adr/README.md) — start with
[ADR-000](docs/adr/000-design-philosophy.md) and the index.

```sh
npm install && npm run build
node dist/cli/index.js init       # writes ~/.config/mcp-router/config.yaml
node dist/cli/index.js validate
node dist/cli/index.js run        # speaks MCP on stdio
node dist/cli/index.js stats      # metrics snapshot of the running router
npm test                          # 40 tests incl. InMemoryTransport e2e
```

Working today: config schema + validation, downstream stdio/HTTP clients with
graceful per-account failure, tool merging with the injected `account` enum,
the five-step route resolver, account markers on implicit routes,
`switch_account`/`current_account` sticky defaults, auth-aware account health
in `list_accounts`, `router stats` (persisted metrics snapshot), console
logging, `router init --import` from `claude_desktop_config.json`, and
`router secret set/rm` (OS keychain, hidden input).

Milestones:

- **v0.1** (shipped) — multiple accounts, one provider; merged virtual tools;
  explicit `account` parameter; `router init|validate|run`.
- **v0.2** (this) — sticky active account, per-account call health,
  `router stats`. Still pending from the v0.2 plan: Streamable HTTP upstream
  (per-session state via `Mcp-Session-Id`).
- **v0.3** — cross-provider contexts (`switch_context work`) surfaced as
  tools; expanded CLI (`router contexts|providers|accounts`).

Naming: "MCP Router" describes the mechanism, not the concept; a rename is
deliberately deferred until pre-v1 (cheap then, a distraction now).
