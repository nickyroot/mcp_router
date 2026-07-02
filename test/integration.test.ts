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
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [
      {
        type: "text" as const,
        text: `results from ${account}: ${String(request.params.arguments?.query)}`,
      },
    ],
  }));
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
    expect(text).toContain('personal — "Personal workspace" (connected)');
    expect(text).toContain("startup (connected)");
  });

  it("records metrics per provider/account/tool", () => {
    const lines = app.metrics.summaryLines();
    expect(lines.some((l) => l.startsWith("notion/personal/search_pages"))).toBe(true);
  });
});
