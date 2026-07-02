// Upstream MCP server facade (ADR-002, ADR-005). Exposes the merged virtual
// tools plus the router's own management tools, resolves routes, forwards
// calls, and relays results verbatim — appending only the account marker of
// ADR-000 on implicitly routed calls.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { accountLabels, type RouterConfig } from "../config/schema.js";
import type { DownstreamManager } from "../downstream/manager.js";
import type { LogicalTool } from "../registry/merge.js";
import {
  compose,
  type CallContext,
  type Middleware,
} from "../router/middleware.js";
import { resolveRoute } from "../router/resolve.js";
import type { SessionState } from "../state/store.js";
import { VERSION } from "../version.js";

/** Logical tools colliding with these get provider-prefixed (ADR-008). */
export const MANAGEMENT_TOOL_NAMES = ["list_accounts"];

export interface UpstreamDeps {
  config: RouterConfig;
  state: SessionState;
  manager: DownstreamManager;
  getTools(): LogicalTool[];
  middlewares: Middleware[];
}

const textResult = (text: string, isError = false): CallToolResult => ({
  content: [{ type: "text" as const, text }],
  ...(isError ? { isError: true } : {}),
});

function renderAccounts(deps: UpstreamDeps): string {
  const lines: string[] = [];
  const statuses = deps.manager.statuses();
  for (const provider of Object.keys(deps.config.providers)) {
    lines.push(`${provider}:`);
    const labels = accountLabels(deps.config, provider);
    for (const status of statuses.filter((s) => s.provider === provider)) {
      const label = labels[status.account] ? ` — "${labels[status.account]}"` : "";
      const availability = status.connected
        ? "connected"
        : `unavailable${status.error ? `: ${status.error}` : ""}`;
      lines.push(`  - ${status.account}${label} (${availability})`);
    }
  }
  return lines.join("\n");
}

export function createUpstreamServer(deps: UpstreamDeps): Server {
  const server = new Server(
    { name: "mcp-router", version: VERSION },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = [
      {
        name: "list_accounts",
        description:
          "List every provider and account configured in MCP Router, with labels and availability.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
      ...deps.getTools().map((tool) => ({
        name: tool.name,
        ...(tool.description !== undefined
          ? { description: tool.description }
          : {}),
        inputSchema: tool.inputSchema as Tool["inputSchema"],
        annotations: { readOnlyHint: tool.readOnly },
      })),
    ];
    return { tools };
  });

  const handler = async (ctx: CallContext): Promise<CallToolResult> => {
    if (ctx.toolName === "list_accounts") {
      ctx.outcome = "ok";
      return textResult(renderAccounts(deps));
    }

    const tool = deps.getTools().find((t) => t.name === ctx.toolName);
    if (!tool) {
      ctx.outcome = "unknown-tool";
      return textResult(`Unknown tool "${ctx.toolName}".`, true);
    }
    ctx.provider = tool.provider;

    const decision = resolveRoute(
      tool,
      ctx.args,
      deps.state.routeState(),
      accountLabels(deps.config, tool.provider),
    );
    if (decision.kind === "ask") {
      ctx.outcome = "ask";
      return textResult(decision.text);
    }
    if (decision.kind === "error") {
      ctx.outcome = "error";
      return textResult(decision.text, true);
    }

    ctx.account = decision.account;
    ctx.step = decision.step;
    try {
      const result = await deps.manager.callTool(
        tool.provider,
        decision.account,
        decision.physicalTool,
        decision.args,
      );
      ctx.outcome = result.isError ? "error" : "ok";
      if (!decision.marked) return result;
      return {
        ...result,
        content: [
          ...(result.content ?? []),
          { type: "text" as const, text: `[account: ${decision.account}]` },
        ],
      };
    } catch (err) {
      ctx.outcome = "error";
      return textResult((err as Error).message, true);
    }
  };

  const composed = compose(deps.middlewares, handler);

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const ctx: CallContext = {
      toolName: request.params.name,
      args: (request.params.arguments ?? {}) as Record<string, unknown>,
      outcome: "error",
    };
    return composed(ctx);
  });

  return server;
}
