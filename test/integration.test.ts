// End-to-end over InMemoryTransport (ADR-001): two fake "notion" downstream
// servers exposing the same tool, a real router in between, and a real MCP
// client upstream. No child processes.

import { beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { buildRouter, type RouterApp } from "../src/app";
import { parseConfig } from "../src/config/load";
import { silentLogger } from "../src/log";
import type { TransportFactory } from "../src/downstream/manager";

const CONFIG = `
providers:
  notion:
    accounts:
      personal:
        label: "Personal workspace"
        server: { command: unused }
      startup:
        server: { command: unused }
contexts:
  work:
    notion: startup
`;

function makeFixtureServer(account: string): Server {
  const server = new Server(
    { name: `fixture-${account}`, version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_pages",
        description: "Search pages in the workspace",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      {
        name: "boom",
        description: "Always fails with isError",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "http_error",
        description: "Wraps an HTTP 401 in a non-error result (Notion-style)",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "boom") {
      return {
        content: [{ type: "text" as const, text: "kaboom" }],
        isError: true,
      };
    }
    if (request.params.name === "http_error") {
      return {
        content: [
          {
            type: "text" as const,
            text: '{"status":401,"object":"error","code":"unauthorized","message":"API token is invalid."}',
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `results from ${account}: ${String(request.params.arguments?.query)}`,
        },
      ],
    };
  });
  return server;
}

const factory: TransportFactory = async (ref) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await makeFixtureServer(ref.account).connect(serverTransport);
  return clientTransport;
};

const textOf = (result: CallToolResult): string =>
  (result.content ?? [])
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("\n");

describe("router end to end", () => {
  let app: RouterApp;
  let client: Client;

  beforeAll(async () => {
    const { config } = parseConfig(CONFIG);
    app = await buildRouter(config, silentLogger, factory);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await app.server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  it("exposes one merged tool plus management tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("search_pages");
    expect(names).toContain("list_accounts");
    expect(names.filter((n) => n === "search_pages")).toHaveLength(1);

    const searchPages = tools.find((t) => t.name === "search_pages")!;
    const properties = searchPages.inputSchema.properties as Record<
      string,
      { enum?: string[] }
    >;
    expect(properties.account.enum).toEqual(["personal", "startup"]);
  });

  it("asks when the account is ambiguous", async () => {
    const result = (await client.callTool({
      name: "search_pages",
      arguments: { query: "roadmap" },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Multiple notion accounts are available");
    expect(textOf(result)).toContain('personal ("Personal workspace")');
  });

  it("routes on an explicit account without a marker", async () => {
    const result = (await client.callTool({
      name: "search_pages",
      arguments: { query: "roadmap", account: "personal" },
    })) as CallToolResult;
    expect(textOf(result)).toBe("results from personal: roadmap");
  });

  it("errors instructively on an unknown account", async () => {
    const result = (await client.callTool({
      name: "search_pages",
      arguments: { query: "roadmap", account: "nope" },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unknown notion account "nope"');
  });

  it("routes via sticky account with a visible marker", async () => {
    app.state.stickyAccounts.notion = "startup";
    try {
      const result = (await client.callTool({
        name: "search_pages",
        arguments: { query: "roadmap" },
      })) as CallToolResult;
      expect(textOf(result)).toContain("results from startup: roadmap");
      expect(textOf(result)).toContain("[account: startup]");
    } finally {
      delete app.state.stickyAccounts.notion;
    }
  });

  it("lists accounts with labels and availability", async () => {
    const result = (await client.callTool({
      name: "list_accounts",
      arguments: {},
    })) as CallToolResult;
    const text = textOf(result);
    expect(text).toContain("notion:");
    expect(text).toContain('personal — "Personal workspace" (connected');
    expect(text).toMatch(/- startup \(connected/);
  });

  it("records metrics per provider/account/tool", () => {
    const lines = app.metrics.summaryLines();
    expect(lines.some((l) => l.startsWith("notion/personal/search_pages"))).toBe(true);
  });

  it("switch_account sets a sticky default; clearing restores ask", async () => {
    const switched = (await client.callTool({
      name: "switch_account",
      arguments: { provider: "notion", account: "startup" },
    })) as CallToolResult;
    expect(switched.isError).toBeFalsy();
    expect(textOf(switched)).toContain("Using startup");

    const routed = (await client.callTool({
      name: "search_pages",
      arguments: { query: "roadmap" },
    })) as CallToolResult;
    expect(textOf(routed)).toContain("results from startup: roadmap");
    expect(textOf(routed)).toContain("[account: startup]");

    const current = (await client.callTool({
      name: "current_account",
      arguments: {},
    })) as CallToolResult;
    expect(textOf(current)).toContain("notion: startup");

    const cleared = (await client.callTool({
      name: "switch_account",
      arguments: { provider: "notion" },
    })) as CallToolResult;
    expect(textOf(cleared)).toContain("Cleared");

    const asking = (await client.callTool({
      name: "search_pages",
      arguments: { query: "roadmap" },
    })) as CallToolResult;
    expect(textOf(asking)).toContain("Multiple notion accounts are available");
  });

  it("switch_account rejects unknown accounts and providers", async () => {
    const badAccount = (await client.callTool({
      name: "switch_account",
      arguments: { provider: "notion", account: "nope" },
    })) as CallToolResult;
    expect(badAccount.isError).toBe(true);
    expect(textOf(badAccount)).toContain('Unknown notion account "nope"');

    const badProvider = (await client.callTool({
      name: "switch_account",
      arguments: { provider: "github", account: "x" },
    })) as CallToolResult;
    expect(badProvider.isError).toBe(true);
    expect(textOf(badProvider)).toContain('Unknown provider "github"');
  });

  it("current_account explains defaults when nothing is active", async () => {
    const result = (await client.callTool({
      name: "current_account",
      arguments: { provider: "notion" },
    })) as CallToolResult;
    expect(textOf(result)).toContain("notion: (none — ambiguous calls will ask)");
  });

  it("switch_context activates a context; sticky set afterwards overrides it", async () => {
    // A pre-existing sticky override gets cleared when the context covers it.
    await client.callTool({
      name: "switch_account",
      arguments: { provider: "notion", account: "personal" },
    });
    const switched = (await client.callTool({
      name: "switch_context",
      arguments: { context: "work" },
    })) as CallToolResult;
    expect(textOf(switched)).toContain('Context "work" is now active');
    expect(textOf(switched)).toContain("notion → startup");
    expect(textOf(switched)).toContain("Cleared per-provider overrides for: notion");

    const viaContext = (await client.callTool({
      name: "search_pages",
      arguments: { query: "roadmap" },
    })) as CallToolResult;
    expect(textOf(viaContext)).toContain("results from startup: roadmap");
    expect(textOf(viaContext)).toContain("[account: startup]");

    const current = (await client.callTool({
      name: "current_context",
      arguments: {},
    })) as CallToolResult;
    expect(textOf(current)).toContain("Active context: work");

    // switch_account after switch_context is a deliberate exception and wins.
    await client.callTool({
      name: "switch_account",
      arguments: { provider: "notion", account: "personal" },
    });
    const viaSticky = (await client.callTool({
      name: "search_pages",
      arguments: { query: "roadmap" },
    })) as CallToolResult;
    expect(textOf(viaSticky)).toContain("results from personal: roadmap");

    // Cleanup: back to default context, no sticky.
    await client.callTool({ name: "switch_context", arguments: {} });
    await client.callTool({
      name: "switch_account",
      arguments: { provider: "notion" },
    });
    const reset = (await client.callTool({
      name: "current_context",
      arguments: {},
    })) as CallToolResult;
    expect(textOf(reset)).toContain("Active context: default");
  });

  it("list_contexts shows mappings and rejects unknown contexts", async () => {
    const listed = (await client.callTool({
      name: "list_contexts",
      arguments: {},
    })) as CallToolResult;
    expect(textOf(listed)).toContain('work: notion → startup');

    const bad = (await client.callTool({
      name: "switch_context",
      arguments: { context: "vacation" },
    })) as CallToolResult;
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('unknown context "vacation"');
  });

  it("surfaces per-account call failures in list_accounts", async () => {
    await client.callTool({
      name: "boom",
      arguments: { account: "personal" },
    });
    await client.callTool({
      name: "http_error",
      arguments: { account: "startup" },
    });

    const accounts = textOf(
      (await client.callTool({
        name: "list_accounts",
        arguments: {},
      })) as CallToolResult,
    );
    const personalLine = accounts.split("\n").find((l) => l.includes("personal"))!;
    const startupLine = accounts.split("\n").find((l) => l.includes("- startup"))!;
    expect(personalLine).toContain("last call failed");
    expect(personalLine).toContain("kaboom");
    expect(startupLine).toContain("last call failed");
    expect(startupLine).toContain("API token is invalid");
  });
});
