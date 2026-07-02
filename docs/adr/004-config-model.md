# ADR-004: Config model — accounts define, contexts reference

Status: Accepted

## Context

Two hierarchies were proposed for the config file:

1. **Provider-first:** providers contain accounts; contexts (v0.3) are a
   separate block referencing them.
2. **Context-first:** contexts contain providers contain accounts —
   "contexts are the product, accounts are an implementation detail."

The context-first instinct is right about the *product*: contexts are the
feature users will love. But it is wrong about the *config shape*: an account
is where the server command and credentials live, and multiple contexts must
reference the same account. Nesting accounts inside contexts forces either
duplicated credential wiring or an ad-hoc reference syntax — reinventing
hierarchy 1 with extra steps.

## Decision

Definition and grouping are separate layers. Accounts **define** what exists;
contexts **reference** accounts by name:

```yaml
providers:
  notion:
    accounts:
      personal:
        server:
          command: npx
          args: ["-y", "@notionhq/notion-mcp-server"]
          env:
            NOTION_TOKEN: ${keychain:notion-personal}   # see ADR-009
        label: "Personal workspace"
      startup:
        server: { command: npx, args: ["-y", "@notionhq/notion-mcp-server"], env: { NOTION_TOKEN: ${keychain:notion-startup} } }
  github:
    accounts:
      personal: { server: ... }
      company:  { server: ... }

contexts:
  work:
    notion: startup
    github: company
  personal:
    notion: personal
    github: personal
```

The `server` block deliberately matches the `command`/`args`/`env` shape of
`claude_desktop_config.json`, so `router init` can import existing configs
(ADR-007). Format is YAML with a published JSON Schema (generated from the
zod schema, so it can never drift). File lives at
`~/.config/mcp-router/config.yaml`, overridable via `--config`.

`router validate` enforces referential integrity: every context entry names an
existing provider and account; no duplicate context names; labels unique per
provider.

## Consequences

- Contexts stay cheap: adding one is pure grouping, no credential handling.
- The `contexts` block ships in the schema from v0.1 (validated, usable) even
  though the UX around it arrives in v0.3 — early adopters' configs never
  need migration.
- A context may cover only some providers; requests to an uncovered provider
  fall through to the next resolution step (ADR-005) rather than erroring.
