// Hot reload (v0.3): applyConfig against a live router — accounts appear,
// disappear, and stale session state is cleared loudly, all without a
// restart. Uses the same InMemoryTransport fixtures as the integration
// suite.

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { buildRouter } from "../src/app";
import { parseConfig } from "../src/config/load";
import type { TransportFactory } from "../src/downstream/manager";
import { silentLogger } from "../src/log";

const configWith = (accounts: string[], contexts = ""): string => `
providers:
  notion:
    accounts:
${accounts
  .map((a) => `      ${a}:\n        server: { command: unused }`)
  .join("\n")}
${contexts}`;

function makeFixtureServer(account: string): Server {
  const server = new Server(
    { name: `fixture-${account}`, version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_pages",
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

const accountEnum = async (client: Client): Promise<string[] | undefined> => {
  const { tools } = await client.listTools();
  const search = tools.find((t) => t.name === "search_pages");
  const properties = search?.inputSchema.properties as
    | Record<string, { enum?: string[] }>
    | undefined;
  return properties?.account?.enum;
};

const textOf = (result: CallToolResult): string =>
  (result.content ?? [])
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("\n");

describe("config hot reload", () => {
  it("adds, removes, and reconciles accounts on a live router", async () => {
    const { config } = parseConfig(
      configWith(
        ["personal", "startup"],
        "contexts:\n  work:\n    notion: startup\n",
      ),
    );
    const app = await buildRouter(config, silentLogger, factory);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await app.server.connect(serverTransport);
    const client = new Client(
      { name: "reload-test", version: "0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    expect(await accountEnum(client)).toEqual(["personal", "startup"]);

    // Add an account: enum grows, new account is immediately routable.
    const { config: withClient } = parseConfig(
      configWith(
        ["personal", "startup", "client"],
        "contexts:\n  work:\n    notion: startup\n",
      ),
    );
    await app.applyConfig(withClient);
    expect(await accountEnum(client)).toEqual(["client", "personal", "startup"]);
    const routed = (await client.callTool({
      name: "search_pages",
      arguments: { query: "x", account: "client" },
    })) as CallToolResult;
    expect(textOf(routed)).toBe("results from client: x");

    // Remove the account that is sticky-active and drop the active context:
    // both must be cleared, never routed to silently (ADR-000).
    app.state.setStickyAccount("notion", "client");
    app.state.switchContext("work");
    const { config: shrunk } = parseConfig(configWith(["personal", "startup"]));
    await app.applyConfig(shrunk);

    expect(await accountEnum(client)).toEqual(["personal", "startup"]);
    expect(app.state.stickyAccounts.notion).toBeUndefined();
    expect(app.state.activeContextName).toBe("default");

    // The removed account is gone from routing entirely.
    const gone = (await client.callTool({
      name: "search_pages",
      arguments: { query: "x", account: "client" },
    })) as CallToolResult;
    expect(gone.isError).toBe(true);

    await client.close();
  });

  it("keeps unchanged accounts connected across a reload", async () => {
    const { config } = parseConfig(configWith(["personal", "startup"]));
    const app = await buildRouter(config, silentLogger, factory);

    // Reload with an identical config: no connections are torn down, so
    // health history survives.
    await app.manager.callTool("notion", "personal", "search_pages", {
      query: "x",
    });
    const before = app.manager
      .statuses()
      .find((s) => s.account === "personal")!.lastOkAt;
    expect(before).toBeDefined();

    await app.applyConfig(config);
    const after = app.manager
      .statuses()
      .find((s) => s.account === "personal")!;
    expect(after.connected).toBe(true);
    expect(after.lastOkAt).toBe(before);
  });
});
