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
import type {
  AccountStatus,
  DownstreamManager,
} from "../downstream/manager.js";
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
export const MANAGEMENT_TOOL_NAMES = [
  "list_accounts",
  "switch_account",
  "current_account",
];

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

function timeAgo(iso: string): string {
  const seconds = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "connected" alone only means the child process is alive; fold in the
 * outcome of the most recent call so a dead credential is visible (v0.2). */
function describeAvailability(status: AccountStatus): string {
  if (!status.connected) {
    return `unavailable${status.error ? `: ${status.error}` : ""}`;
  }
  const failedAfterOk =
    status.lastError !== undefined &&
    (status.lastOkAt === undefined || status.lastError.at > status.lastOkAt);
  if (failedAfterOk && status.lastError) {
    return `connected, last call failed ${timeAgo(status.lastError.at)}: ${status.lastError.message}`;
  }
  if (status.lastOkAt !== undefined) {
    return `connected, ok ${timeAgo(status.lastOkAt)}`;
  }
  return "connected";
}

function renderAccounts(deps: UpstreamDeps): string {
  const lines: string[] = [];
  const statuses = deps.manager.statuses();
  for (const provider of Object.keys(deps.config.providers)) {
    lines.push(`${provider}:`);
    const labels = accountLabels(deps.config, provider);
    const active = deps.state.stickyAccounts[provider];
    for (const status of statuses.filter((s) => s.provider === provider)) {
      const label = labels[status.account] ? ` — "${labels[status.account]}"` : "";
      const activeMark = status.account === active ? " [active]" : "";
      lines.push(
        `  - ${status.account}${label}${activeMark} (${describeAvailability(status)})`,
      );
    }
  }
  return lines.join("\n");
}

export function createUpstreamServer(deps: UpstreamDeps): Server {
  const server = new Server(
    { name: "mcp-router", version: VERSION },
    { capabilities: { tools: { listChanged: true } } },
  );

  const providerNames = Object.keys(deps.config.providers);
  const describeAccount = (provider: string, account: string): string => {
    const label = accountLabels(deps.config, provider)[account];
    return label ? `${account} ("${label}")` : account;
  };

  const managementTools = (): Tool[] => [
    {
      name: "list_accounts",
      description:
        "List every provider and account configured in MCP Router, with labels, availability, and which account is active.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: "switch_account",
      description:
        "Set the active account for a provider. Later tool calls without an explicit account parameter route to it (explicit parameters still override). Omit account to clear.",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string", enum: providerNames },
          account: {
            type: "string",
            description:
              "Account name to make active. Omit to clear the active account for this provider.",
          },
        },
        required: ["provider"],
      },
    },
    {
      name: "current_account",
      description:
        "Show which account is active for each provider (or one provider).",
      inputSchema: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            enum: providerNames,
            description: "Limit the answer to one provider.",
          },
        },
      },
      annotations: { readOnlyHint: true },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = [
      ...managementTools(),
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

  const validProvider = (value: unknown): string | undefined =>
    typeof value === "string" && value in deps.config.providers
      ? value
      : undefined;

  const handleSwitchAccount = (ctx: CallContext): CallToolResult => {
    const provider = validProvider(ctx.args.provider);
    if (provider === undefined) {
      ctx.outcome = "error";
      return textResult(
        `Unknown provider "${String(ctx.args.provider)}". Configured providers: ${providerNames.join(", ")}.`,
        true,
      );
    }
    ctx.provider = provider;
    const account = ctx.args.account;
    if (account === undefined) {
      deps.state.clearStickyAccount(provider);
      ctx.outcome = "ok";
      return textResult(
        `Cleared the active ${provider} account; ambiguous calls will ask again.`,
      );
    }
    const accounts = Object.keys(deps.config.providers[provider].accounts);
    if (typeof account !== "string" || !accounts.includes(account)) {
      ctx.outcome = "error";
      return textResult(
        `Unknown ${provider} account "${String(account)}". Valid accounts: ${accounts
          .map((a) => describeAccount(provider, a))
          .join(", ")}.`,
        true,
      );
    }
    deps.state.setStickyAccount(provider, account);
    ctx.account = account;
    ctx.outcome = "ok";
    return textResult(
      `Using ${describeAccount(provider, account)} for ${provider} from now on. ` +
        `Explicit "account" parameters still override this. ` +
        `(This default is shared by every conversation using this router.)`,
    );
  };

  const handleCurrentAccount = (ctx: CallContext): CallToolResult => {
    let scope = providerNames;
    if (ctx.args.provider !== undefined) {
      const provider = validProvider(ctx.args.provider);
      if (provider === undefined) {
        ctx.outcome = "error";
        return textResult(
          `Unknown provider "${String(ctx.args.provider)}". Configured providers: ${providerNames.join(", ")}.`,
          true,
        );
      }
      scope = [provider];
      ctx.provider = provider;
    }
    const lines = scope.map((provider) => {
      const sticky = deps.state.stickyAccounts[provider];
      if (sticky !== undefined) {
        return `${provider}: ${describeAccount(provider, sticky)} — active via switch_account`;
      }
      const accounts = Object.keys(deps.config.providers[provider].accounts);
      if (accounts.length === 1) {
        return `${provider}: ${describeAccount(provider, accounts[0])} (only configured account)`;
      }
      return `${provider}: (none — ambiguous calls will ask)`;
    });
    ctx.outcome = "ok";
    return textResult(lines.join("\n"));
  };

  const handler = async (ctx: CallContext): Promise<CallToolResult> => {
    if (MANAGEMENT_TOOL_NAMES.includes(ctx.toolName)) {
      ctx.step = "management";
    }
    if (ctx.toolName === "list_accounts") {
      ctx.outcome = "ok";
      return textResult(renderAccounts(deps));
    }
    if (ctx.toolName === "switch_account") return handleSwitchAccount(ctx);
    if (ctx.toolName === "current_account") return handleCurrentAccount(ctx);

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
