# ADR-000: Design philosophy — invisible plumbing, visible decisions

Status: Accepted

## Context

The router sits between an AI client and multiple downstream MCP servers, each
authenticated as a different account. Every design decision below flows from a
single question: what should the model (and the human behind it) experience?

Two failure modes bound the design space:

1. **Leaking infrastructure.** If the model sees three copies of every tool,
   or has to reason about child processes and credentials, the router has
   failed at its one job.
2. **Silent misdirection.** If the router quietly resolves ambiguity and a
   write lands in the wrong workspace, that is the worst possible outcome —
   worse than any error message. A wrong page created in a client's Notion
   workspace is a trust-destroying event.

An earlier draft of this philosophy said only "the implementation should
remain invisible whenever possible." Review surfaced that this, taken alone,
actively encourages failure mode 2.

## Decision

> The router presents AI clients with the illusion of a single coherent
> identity layer rather than many independent authenticated services. The
> plumbing — multiple downstream servers, credentials, child processes,
> routing logic — stays invisible. The **decisions** — which account a request
> was routed to, especially for anything that mutates state — stay visible,
> every time.

Concretely:

- Tool lists are merged; the model never sees per-account duplicates (ADR-002).
- Routing is automatic when unambiguous (ADR-005).
- Any tool result produced under an implicitly chosen account carries a
  visible marker, e.g. `[account: startup]`.
- The router never guesses on ambiguous **writes**. Reads may fall back to a
  default; mutations with more than one plausible target ask first.

## Consequences

- Every feature proposal gets evaluated against both clauses, not just the
  first. "Would this make the seams show?" and "could this route something
  silently?" are both blocking questions.
- Result payloads are slightly noisier (the account marker). This is a price
  we pay on purpose.
- The read/write distinction requires knowing which tools mutate state. MCP
  tool annotations (`readOnlyHint`) supply this when present; when absent we
  treat tools as writes (conservative default).
