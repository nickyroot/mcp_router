# ADR-001: TypeScript with the official MCP SDK

Status: Accepted

## Context

The router is simultaneously an MCP **server** (upstream, facing the AI
client) and an MCP **client** (downstream, facing each account's server). We
need a language and protocol library that covers both halves well, distributes
easily to Claude Desktop / Cursor users, and keeps the dependency count low.

## Options considered

**TypeScript + `@modelcontextprotocol/sdk`** — the reference SDK. Client and
server primitives in one package, first to receive spec updates, includes
`InMemoryTransport` (client and server wired directly in-process, no child
processes needed) which makes the routing logic testable without fixtures on
disk. Distribution via `npx mcp-router` matches how users already install MCP
servers. Runtime requirement: Node ≥ 18, which anyone running local MCP
servers already has.

**Python + official SDK / FastMCP** — excellent server ergonomics, but the
client half is less exercised in the wild, and `uvx`/pip distribution is a
step behind `npx` for this audience. Most popular downstream servers are also
TS, so cross-language debugging would be constant.

**Go** — single static binary is genuinely attractive for a CLI tool. But the
Go SDK is younger, we'd hand-roll more protocol handling, and the contributor
pool for an OSS MCP project skews heavily TS.

## Decision

TypeScript, strict mode, ESM, targeting Node ≥ 18. Protocol handling
exclusively through `@modelcontextprotocol/sdk` — we do not parse or emit
JSON-RPC ourselves. Zod for config validation (already a peer dependency of
the SDK, so it costs nothing).

Dependency budget: SDK, zod, a keychain binding (ADR-009), and a minimal CLI
arg parser. Anything beyond that needs a stated reason.

## Consequences

- Spec churn is absorbed by SDK upgrades rather than by our code (see ADR-012).
- We inherit the SDK's transport implementations (stdio, Streamable HTTP) for
  free on both halves.
- No single-binary distribution. If that ever matters, Node SEA or Bun compile
  are escape hatches — but `npx` is the expected install path for this
  ecosystem, so this is theoretical.
