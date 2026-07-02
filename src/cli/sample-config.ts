export const SAMPLE_CONFIG = `# MCP Router configuration (ADR-004)
#
# providers/accounts define what exists; contexts are named groupings that
# reference them. The server block matches claude_desktop_config.json
# (command/args/env), so entries can be copied over directly — or imported
# with: router init --import <path-to-claude_desktop_config.json>
#
# Secrets are references, never values (ADR-009):
#   \${env:NAME}       resolved from the router's environment
#   \${keychain:name}  resolved from the OS keychain (router secret set <name>)

providers:
  notion:
    # inject_account: true   # default; adds an optional "account" enum to merged tools
    accounts:
      personal:
        label: "Personal workspace"
        server:
          command: npx
          args: ["-y", "@notionhq/notion-mcp-server"]
          env:
            NOTION_TOKEN: \${env:NOTION_TOKEN_PERSONAL}
      startup:
        label: "Startup workspace"
        server:
          command: npx
          args: ["-y", "@notionhq/notion-mcp-server"]
          env:
            NOTION_TOKEN: \${env:NOTION_TOKEN_STARTUP}

# Contexts arrive as a first-class UX in v0.3, but are validated and usable
# from v0.1 (ADR-005).
contexts:
  work:
    notion: startup
`;
