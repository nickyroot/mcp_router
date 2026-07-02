import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config/load";

const VALID = `
providers:
  notion:
    accounts:
      personal:
        label: "Personal workspace"
        server:
          command: npx
          args: ["-y", "@notionhq/notion-mcp-server"]
          env:
            NOTION_TOKEN: \${env:NOTION_TOKEN_PERSONAL}
      startup:
        server:
          command: npx
          args: ["-y", "@notionhq/notion-mcp-server"]
          env:
            NOTION_TOKEN: \${keychain:notion-startup}
contexts:
  work:
    notion: startup
`;

describe("parseConfig", () => {
  it("accepts a valid config with defaults applied", () => {
    const { config, warnings } = parseConfig(VALID);
    expect(warnings).toEqual([]);
    expect(config.providers.notion.inject_account).toBe(true);
    expect(config.providers.notion.accounts.personal.server).toMatchObject({
      command: "npx",
    });
    expect(config.contexts.work).toEqual({ notion: "startup" });
  });

  it("rejects a context referencing an unknown account", () => {
    const text = VALID.replace("notion: startup", "notion: nonexistent");
    expect(() => parseConfig(text)).toThrowError(ConfigError);
    try {
      parseConfig(text);
    } catch (err) {
      expect((err as ConfigError).issues.join("\n")).toContain(
        'no account "nonexistent"',
      );
    }
  });

  it("rejects a context referencing an unknown provider", () => {
    const text = VALID.replace("notion: startup", "github: startup");
    expect(() => parseConfig(text)).toThrowError(/unknown provider "github"/);
  });

  it("rejects duplicate labels within a provider", () => {
    const text = VALID.replace(
      "startup:\n        server:",
      'startup:\n        label: "Personal workspace"\n        server:',
    );
    expect(() => parseConfig(text)).toThrowError(/label "Personal workspace"/);
  });

  it("rejects a provider with no accounts", () => {
    expect(() => parseConfig("providers:\n  notion:\n    accounts: {}\n")).toThrowError(
      /has no accounts/,
    );
  });

  it("rejects invalid account names", () => {
    const text = VALID.replaceAll("startup:", "Bad Name:").replace(
      "notion: Bad Name",
      "notion: personal",
    );
    expect(() => parseConfig(text)).toThrowError(ConfigError);
  });

  it("warns about plaintext secrets", () => {
    const text = VALID.replace(
      "NOTION_TOKEN: ${env:NOTION_TOKEN_PERSONAL}",
      "NOTION_TOKEN: secret_abc123",
    );
    const { warnings } = parseConfig(text);
    expect(warnings.some((w) => w.includes("plaintext"))).toBe(true);
  });

  it("rejects unknown top-level keys", () => {
    expect(() => parseConfig(`${VALID}\nrouters: {}\n`)).toThrowError(ConfigError);
  });
});
