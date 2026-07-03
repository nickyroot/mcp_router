# ADR-005: Route resolution order, with context on top from day one

Status: Accepted

## Context

Given a call to a merged tool, the router must produce exactly one
(account, physical tool) pair — or decline visibly. The resolution rules are
the heart of the product and must be a pure function: inputs (call arguments,
session state, config) in, decision out. No I/O, fully unit-testable.

A separate question: contexts are a v0.3 *feature*, but retrofitting them
into a v0.1 resolution chain built around single accounts would mean
redesigning the core later. Review pushed to treat contexts as first-class
from the start; we agree with the architectural version of that claim.

## Decision

Resolution order, first match wins (as amended below):

1. **Explicit parameter.** `account` argument present → validate against the
   provider's accounts → route. Unknown name → instructive error listing
   valid names. Never falls through silently.
2. **Provider default / sticky account.** A per-provider active account set by
   `switch_account` (v0.2) → route, marking the result `[account: X]`.
3. **Active context.** If the active context maps this tool's provider to an
   account → route, marked.
4. **Singleton.** Exactly one account configured for the provider → route,
   unmarked (nothing was chosen).
5. **Ask.** Return a normal, `isError: false` result:

   > Multiple Notion accounts are available: personal ("Personal workspace"),
   > startup, client. Re-call this tool with the `account` parameter, or use
   > `switch_account` to set a default.

   A non-error result is used because models treat errors as failures to
   retry or apologize for; this is a request for a decision, and models
   follow it reliably. MCP *elicitation* (asking the human directly) is a
   possible future enhancement behind a config flag, but client support is
   too uneven to depend on (ADR-012).

Per ADR-000, step 5 is also triggered — regardless of steps 2–3 — when the
tool is a **write** (no `readOnlyHint: true`) and the router considers the
route ambiguous; v0.1 keeps this simple: writes resolved by steps 2–3 are
allowed but always marked, writes reaching step 4/5 with multiple candidates
always ask.

From v0.1 there is always exactly one active context — the implicit `default`
(empty) context — so step 2 exists in the code path from the first release.
v0.3 merely lets users define and switch named contexts; the resolver never
changes shape.

## Amendment (v0.3, 2026-07-03)

The original order placed context (step 2) above sticky account (step 3).
Building `switch_context` exposed the flaw: with context on top, saying
"switch my Notion to personal" while the `work` context is active would be
silently ignored — the precise failure ADR-000 forbids. The order is now
**explicit > sticky > context > singleton**: the more specific, more recent
instruction wins. To keep the mental model clean, `switch_context` clears
sticky overrides for the providers the new context covers — entering a
context resets per-provider exceptions, visibly. This amendment shipped
before sticky and contexts ever coexisted in a release, so no user-observable
behavior changed.

## Consequences

- The resolver is a pure module with exhaustive table-driven tests; every
  future policy feature (approvals, RBAC) slots in as middleware *around* it
  (ADR-010), not as new branches inside it.
- Step ordering is part of the public contract and documented in the README;
  changing it is a breaking change requiring a superseding ADR.
- Management tools (`list_accounts`, `current_account`, `switch_account`,
  `switch_context`, `current_context`) are themselves ordinary MCP tools
  exposed by the router — no special protocol machinery.
