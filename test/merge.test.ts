import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  mergeTools,
  type DownstreamTool,
  type ProviderSettings,
} from "../src/registry/merge";

const makeTool = (
  name: string,
  properties: Record<string, unknown> = { query: { type: "string" } },
  extra: Partial<Tool> = {},
): Tool => ({
  name,
  description: "a tool",
  inputSchema: { type: "object", properties, required: Object.keys(properties) },
  ...extra,
});

const dt = (provider: string, account: string, tool: Tool): DownstreamTool => ({
  provider,
  account,
  tool,
});

const inject: Record<string, ProviderSettings> = {
  notion: { injectAccount: true },
  github: { injectAccount: true },
};

describe("mergeTools", () => {
  it("merges identical tools across accounts into one logical tool", () => {
    const { tools, warnings } = mergeTools(
      [
        dt("notion", "personal", makeTool("search_pages")),
        dt("notion", "startup", makeTool("search_pages")),
        dt("notion", "client", makeTool("search_pages")),
      ],
      inject,
    );
    expect(warnings).toEqual([]);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("search_pages");
    expect(tools[0].routes).toEqual({
      personal: "search_pages",
      startup: "search_pages",
      client: "search_pages",
    });
  });

  it("merges despite cosmetic schema differences (descriptions)", () => {
    const a = makeTool("search_pages", {
      query: { type: "string", description: "the query" },
    });
    const b = makeTool("search_pages", {
      query: { type: "string", description: "text to search for" },
    });
    const { tools } = mergeTools(
      [dt("notion", "personal", a), dt("notion", "startup", b)],
      inject,
    );
    expect(tools).toHaveLength(1);
  });

  it("injects a sorted account enum when a provider has multiple accounts", () => {
    const { tools } = mergeTools(
      [
        dt("notion", "startup", makeTool("search_pages")),
        dt("notion", "personal", makeTool("search_pages")),
      ],
      inject,
    );
    expect(tools[0].accountParam).toBe("account");
    const properties = tools[0].inputSchema.properties as Record<
      string,
      { enum?: string[] }
    >;
    expect(properties.account.enum).toEqual(["personal", "startup"]);
  });

  it("does not inject for a single account", () => {
    const { tools } = mergeTools(
      [dt("notion", "personal", makeTool("search_pages"))],
      inject,
    );
    expect(tools[0].accountParam).toBeNull();
    const properties = tools[0].inputSchema.properties as Record<string, unknown>;
    expect(properties.account).toBeUndefined();
  });

  it("respects inject_account: false", () => {
    const { tools } = mergeTools(
      [
        dt("notion", "personal", makeTool("search_pages")),
        dt("notion", "startup", makeTool("search_pages")),
      ],
      { notion: { injectAccount: false } },
    );
    expect(tools[0].accountParam).toBeNull();
  });

  it("uses router_account when the tool already defines account", () => {
    const withAccount = makeTool("create_page", {
      title: { type: "string" },
      account: { type: "string" },
    });
    const { tools, warnings } = mergeTools(
      [
        dt("notion", "personal", withAccount),
        dt("notion", "startup", withAccount),
      ],
      inject,
    );
    expect(tools[0].accountParam).toBe("router_account");
    expect(warnings.some((w) => w.includes("router_account"))).toBe(true);
  });

  it("exposes per-account variants on schema skew, with a warning", () => {
    const v1 = makeTool("search_pages", { query: { type: "string" } });
    const v2 = makeTool("search_pages", {
      query: { type: "string" },
      limit: { type: "number" },
    });
    const { tools, warnings } = mergeTools(
      [dt("notion", "personal", v1), dt("notion", "startup", v2)],
      inject,
    );
    expect(tools.map((t) => t.name).sort()).toEqual([
      "search_pages__personal",
      "search_pages__startup",
    ]);
    expect(warnings.some((w) => w.includes("differing schemas"))).toBe(true);
  });

  it("provider-prefixes cross-provider name collisions", () => {
    const { tools } = mergeTools(
      [
        dt("notion", "personal", makeTool("search")),
        dt("github", "work", makeTool("search")),
      ],
      inject,
    );
    expect(tools.map((t) => t.name).sort()).toEqual([
      "github_search",
      "notion_search",
    ]);
  });

  it("provider-prefixes collisions with reserved management tool names", () => {
    const { tools, warnings } = mergeTools(
      [dt("notion", "personal", makeTool("list_accounts"))],
      inject,
      ["list_accounts"],
    );
    expect(tools[0].name).toBe("notion_list_accounts");
    expect(warnings.some((w) => w.includes("management tool"))).toBe(true);
  });

  it("marks a tool read-only only when every variant declares it", () => {
    const readOnly = makeTool("search_pages", undefined, {
      annotations: { readOnlyHint: true },
    });
    const unmarked = makeTool("search_pages");
    const { tools } = mergeTools(
      [dt("notion", "personal", readOnly), dt("notion", "startup", unmarked)],
      inject,
    );
    expect(tools[0].readOnly).toBe(false);

    const { tools: allReadOnly } = mergeTools(
      [
        dt("notion", "personal", readOnly),
        dt("notion", "startup", makeTool("search_pages", undefined, {
          annotations: { readOnlyHint: true },
        })),
      ],
      inject,
    );
    expect(allReadOnly[0].readOnly).toBe(true);
  });
});
