# Architecture Decision Records

Decisions for MCP Router (working title), recorded before implementation.
Each ADR states the decision, the alternatives considered, and the trade-offs —
so that six months from now we know whether we're bending the architecture or
breaking it.

Format: lightweight [Michael Nygard style](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).
Statuses: `Accepted`, `Superseded by ADR-XXX`, `Deprecated`.

| #   | Title                                                                        | Status   |
| --- | ---------------------------------------------------------------------------- | -------- |
| 000 | [Design philosophy: invisible plumbing, visible decisions](000-design-philosophy.md) | Accepted |
| 001 | [TypeScript with the official MCP SDK](001-typescript-official-sdk.md)       | Accepted |
| 002 | [Virtual merged tools, not a transparent proxy](002-virtual-tools.md)        | Accepted |
| 003 | [Account selection: optional parameter plus session state](003-account-selection.md) | Accepted |
| 004 | [Config model: accounts define, contexts reference](004-config-model.md)     | Accepted |
| 005 | [Route resolution order, with context on top from day one](005-route-resolution.md) | Accepted |
| 006 | [Transports and the scope of session state](006-transports-and-state.md)     | Accepted |
| 007 | [Downstream servers come from explicit config](007-explicit-downstream-config.md) | Accepted |
| 008 | [Tool merging and collision rules](008-tool-merging.md)                      | Accepted |
| 009 | [Secrets are references, never values](009-secrets.md)                       | Accepted |
| 010 | [Middleware pipeline as the extension point](010-middleware-pipeline.md)     | Accepted |
| 011 | [Observability: console logs and local metrics](011-observability.md)        | Accepted |
| 012 | [Tracking MCP spec evolution](012-mcp-spec-evolution.md)                     | Accepted |
| 013 | [Non-goals: what this project deliberately is not](013-non-goals.md)         | Accepted |
