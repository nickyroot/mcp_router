# ADR-002: Virtual merged tools, not a transparent proxy

Status: Accepted

## Context

With three Notion accounts, each downstream server exposes the same ~20 tools.
The router must decide what the AI client sees. This is the load-bearing
architectural choice of the project.

## Options considered

**Transparent proxy with namespacing.** Forward every downstream tool,
prefixed per account: `notion_personal_search_pages`,
`notion_startup_search_pages`, … Simple to implement — the router is nearly a
pipe. But 3 accounts × 20 tools = 60 tools for one provider; five providers
puts hundreds of tools in the model's context. Account selection happens by
tool-name pattern matching, which is exactly the "leaking infrastructure"
failure of ADR-000. This design also makes v0.2's session state meaningless —
there is nothing to route.

**Virtual tools.** The router aggregates downstream tool lists, merges
identical tools into one logical tool (rules in ADR-008), and owns the mapping
from logical tool call → (account, physical tool). Claude sees `search_pages`
once. The router becomes a real translation layer: it rewrites schemas,
resolves routes, forwards calls, and relays results.

## Decision

Virtual tools. The merged registry maintains, per logical tool:

```
logical name → { schema, [account → physical tool name] }
```

The indirection between logical and physical names is deliberately part of the
contract, even though in v0.x they are almost always equal. This is the seam
that later allows semantic normalization (mapping `find_pages` /
`query_pages` → one logical `search_documents`) without touching routing —
a possibility we keep open but explicitly do not build (ADR-013).

## Consequences

- The router must re-aggregate when a downstream server changes its tool list
  (`tools/list_changed`) and emit its own `list_changed` upstream.
- Tool count still grows linearly with *providers* (not accounts). Escape
  hatch: a per-provider `tools: allow/deny` filter in config.
- Result relaying must preserve content verbatim (text, images, resources,
  structured content, `isError`) — the router may append the account marker
  of ADR-000 but never rewrites downstream payloads.
- Non-tool primitives (resources, prompts) are not merged in v0.x; this is
  documented as a known limitation rather than half-supported.
