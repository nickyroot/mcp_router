# ADR-013: Non-goals — what this project deliberately is not

Status: Accepted

## Context

An identity-adjacent infrastructure project attracts scope creep of a
specific flavor: every one of the features below is a plausible "wouldn't it
be nice," and each one would quietly convert a small, trustworthy local tool
into a service with a security perimeter. Recording the refusals matters as
much as recording the decisions — future contributors need to know which
walls are load-bearing.

## Decision

The following are out of scope. Items marked ⚓ are *permanent* refusals for
this project (they belong in forks or commercial layers); the rest are
"not now, and only via a superseding ADR."

- ⚓ **Cloud anything** — sync, hosted dashboards, control planes, telemetry.
  The router's security story is "local process, local config, local
  secrets" (ADR-007, ADR-009); every cloud feature breaks it.
- ⚓ **Authentication service** — no OAuth hosting, token minting, or refresh
  logic. We deliver existing secrets to child processes, full stop (ADR-009).
- ⚓ **Billing, teams, RBAC, audit workflows** — enterprise policy features.
  The middleware seam (ADR-010) exists so *others* can build these without
  us; that is the extent of our involvement.
- **Semantic tool normalization** — mapping differently-named downstream
  tools (`find_pages`/`query_pages`) onto one logical tool. The registry's
  logical/physical indirection keeps it possible (ADR-002, ADR-008); the
  reconciliation of parameter and result shapes across servers we don't
  control makes it a tar pit we enter only deliberately, later, if users
  pull hard.
- **Resources and prompts merging** — v0.x merges tools only (ADR-002).
- **Runtime auto-discovery** of MCP servers (ADR-007).
- **A polymorphic `use(name)` switching tool** — one verb that resolves a bare
  name to an account or context. Attractive sugar, but accounts are
  provider-scoped while contexts are global, so a bare name is ambiguous by
  construction (`notion.personal` vs `github.personal`), and models drive
  narrow explicit tools more reliably than clever ones. Revisit after v0.3
  ships `switch_context` and we can watch real usage; it would layer over the
  same `SessionState`, so deferring costs nothing and adding it later is
  non-breaking.
- **Third-party loadable middleware** (ADR-010).
- **Web dashboard / GUI** — the CLI and logs are the interface.

## Consequences

- Feature requests hitting a ⚓ item get a link to this file, not a debate.
- Non-anchored items each name the ADR that keeps the door open, so
  revisiting them later is a design conversation, not an excavation.
- "Do one thing exceptionally well" survives contact with success — the
  thing is routing identities, and the moment a feature isn't about that,
  it lives somewhere else.
