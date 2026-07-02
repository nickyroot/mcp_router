# ADR-008: Tool merging and collision rules

Status: Accepted

## Context

Virtual tools (ADR-002) require rules for when two downstream tools are "the
same tool." Get this wrong in either direction and it hurts: over-merge and a
call routes to a server whose schema differs from what the model saw;
under-merge and the tool list fills with duplicates the product exists to
eliminate.

## Decision

Two downstream tools merge into one logical tool iff:

1. they belong to accounts of the **same provider**, and
2. they have the **same name**, and
3. their `inputSchema`s are **structurally equal** — compared after
   normalization (key order, `description` text, and other cosmetic fields
   stripped), by hash of the canonical JSON.

Rules for everything that doesn't merge cleanly:

- **Same provider, same name, different schema** (server version skew across
  accounts): do not merge. Expose per-account variants suffixed with the
  account name — `search_pages__startup` — and log a prominent warning
  naming the accounts and the schema difference. Correctness over
  cleanliness; the fix is the user upgrading the lagging server.
- **Different providers, colliding names** (two providers both expose
  `search`): prefix with provider — `notion_search`, `linear_search`. Applied
  only on actual collision, so the common case keeps clean names.
- **Descriptions** of merged tools: taken from the first account (config
  order) — they differ only cosmetically by rule 3.
- **Annotations** (`readOnlyHint` etc.): merged conservatively — a tool is
  read-only only if *every* variant declares it (feeds ADR-005's write
  guard).
- **`tools/list_changed`** from any downstream server triggers re-aggregation
  of that provider and a `list_changed` notification upstream. Merging is
  thus a recomputable pure function of current downstream tool lists — no
  incremental mutation of registry state.

## Consequences

- The registry needs a canonical-JSON hasher and schema normalizer; both are
  small, pure, and heavily unit-tested (property: merge decision is
  order-independent across accounts).
- Account-suffixed and provider-prefixed names must survive round-trips: the
  registry maps logical name → (account, physical name), so the downstream
  server always receives its own original tool name.
- A future semantic-normalization layer (mapping differently-named tools to
  one logical tool) would relax rule 2 via explicit config mapping — the
  registry contract already permits it (ADR-002); nothing else changes.
