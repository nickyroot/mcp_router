// Upstream MCP server facade (ADR-002, ADR-005). Exposes the merged virtual
// tools plus the router's own management tools, resolves routes, forwards
// calls, and relays results verbatim — appending only the account marker of
// ADR-000 on implicitly routed calls.
//
// Config is accessed through getConfig() rather than captured, because hot
// reload (v0.3) can replace it while the server is live; tool schemas
// (provider/context enums) are rebuilt on every tools/list.

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
  "list_contexts",
  "switch_context",
  "current_context",
];

export interface UpstreamDeps {
  getConfig(): RouterConfig;
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
    (status.lastOkAt === undefined || status.lastError.at >= status.lastOkAt);
  if (failedAfterOk && status.lastError) {
    return `connected, last call failed ${timeAgo(status.lastError.at)}: ${status.lastError.message}`;
  }
  if (status.lastOkAt !== undefined) {
    return `connected, ok ${timeAgo(status.lastOkAt)}`;
  }
  return "connected";
}

export function createUpstreamServer(deps: UpstreamDeps): Server {
  const server = new Server(
    { name: "mcp-router", version: VERSION },
    { capabilities: { tools: { listChanged: true } } },
  );

  const providerNames = (): string[] => Object.keys(deps.getConfig().providers);

  const describeAccount = (provider: string, account: string): string => {
    const label = accountLabels(deps.getConfig(), provider)[account];
    return label ? `${account} ("${label}")` : account;
  };

  const describeMapping = (mapping: Record<string, string>): string =>
    Object.entries(mapping)
      .map(([provider, account]) => `${provider} → ${describeAccount(provider, account)}`)
      .join(", ") || "(empty — no provider mappings)";

  const renderAccounts = (): string => {
    const lines: string[] = [];
    const statuses = deps.manager.statuses();
    for (const provider of providerNames()) {
      lines.push(`${provider}:`);
      const labels = accountLabels(deps.getConfig(), provider);
      const active = deps.state.stickyAccounts[provider];
      for (const status of statuses.filter((s) => s.provider === provider)) {
        const label = labels[status.account]
          ? ` — "${labels[status.account]}"`
          : "";
        const activeMark = status.account === active ? " [active]" : "";
        lines.push(
          `  - ${status.account}${label}${activeMark} (${describeAvailability(status)})`,
        );
      }
    }
    return lines.join("\n");
  };

  const managementTools = (): Tool[] => {
    const providers = providerNames();
    const contexts = deps.state.contextNames();
    return [
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
          "Set the active account for one provider. Later tool calls without an explicit account parameter route to it (explicit parameters still override). Omit account to clear.",
        inputSchema: {
          type: "object",
          properties: {
            provider: { type: "string", enum: providers },
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
              enum: providers,
              description: "Limit the answer to one provider.",
            },
          },
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "list_contexts",
        description:
          "List the configured contexts (named cross-provider account groupings) and which one is active.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
      {
        name: "switch_context",
        description:
          "Activate a context: every provider it covers routes to that context's account until overridden. Clears per-provider switch_account overrides for covered providers. Omit context to return to the default (empty) context.",
        inputSchema: {
          type: "object",
          properties: {
            context: {
              type: "string",
              ...(contexts.length > 0 ? { enum: contexts } : {}),
              description:
                "Context name to activate. Omit to clear (default context).",
            },
          },
        },
      },
      {
        name: "current_context",
        description: "Show the active context and its provider mappings.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
    ];
  };

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
    typeof value === "string" && value in deps.getConfig().providers
      ? value
      : undefined;

  const handleSwitchAccount = (ctx: CallContext): CallToolResult => {
    const provider = validProvider(ctx.args.provider);
    if (provider === undefined) {
      ctx.outcome = "error";
      return textResult(
        `Unknown provider "${String(ctx.args.provider)}". Configured providers: ${providerNames().join(", ")}.`,
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
    const accounts = Object.keys(
      deps.getConfig().providers[provider].accounts,
    );
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
    let scope = providerNames();
    if (ctx.args.provider !== undefined) {
      const provider = validProvider(ctx.args.provider);
      if (provider === undefined) {
        ctx.outcome = "error";
        return textResult(
          `Unknown provider "${String(ctx.args.provider)}". Configured providers: ${providerNames().join(", ")}.`,
          true,
        );
      }
      scope = [provider];
      ctx.provider = provider;
    }
    const contextAccounts = deps.state.routeState().contextAccounts;
    const lines = scope.map((provider) => {
      const sticky = deps.state.stickyAccounts[provider];
      if (sticky !== undefined) {
        return `${provider}: ${describeAccount(provider, sticky)} — active via switch_account`;
      }
      const fromContext = contextAccounts[provider];
      if (fromContext !== undefined) {
        return `${provider}: ${describeAccount(provider, fromContext)} — via context "${deps.state.activeContextName}"`;
      }
      const accounts = Object.keys(
        deps.getConfig().providers[provider].accounts,
      );
      if (accounts.length === 1) {
        return `${provider}: ${describeAccount(provider, accounts[0])} (only configured account)`;
      }
      return `${provider}: (none — ambiguous calls will ask)`;
    });
    ctx.outcome = "ok";
    return textResult(lines.join("\n"));
  };

  const handleListContexts = (ctx: CallContext): CallToolResult => {
    ctx.outcome = "ok";
    const names = deps.state.contextNames();
    if (names.length === 0) {
      return textResult(
        "No contexts configured. Add a `contexts:` block to the router config to group accounts across providers.",
      );
    }
    const active = deps.state.activeContextName;
    const lines = names.map((name) => {
      const mark = name === active ? " [active]" : "";
      return `${name}${mark}: ${describeMapping(deps.state.contextMapping(name) ?? {})}`;
    });
    if (active === "default") {
      lines.push("(active: default — empty context, no provider mappings)");
    }
    return textResult(lines.join("\n"));
  };

  const handleSwitchContext = (ctx: CallContext): CallToolResult => {
    const name = ctx.args.context;
    const target = name === undefined ? "default" : name;
    if (typeof target !== "string") {
      ctx.outcome = "error";
      return textResult(`Invalid context "${String(name)}".`, true);
    }
    let cleared: string[];
    try {
      cleared = deps.state.switchContext(target);
    } catch (err) {
      ctx.outcome = "error";
      return textResult((err as Error).message, true);
    }
    ctx.outcome = "ok";
    if (target === "default") {
      return textResult(
        "Returned to the default (empty) context; per-provider defaults and explicit parameters still apply.",
      );
    }
    const mapping = deps.state.contextMapping(target) ?? {};
    const clearedNote =
      cleared.length > 0
        ? ` Cleared per-provider overrides for: ${cleared.join(", ")}.`
        : "";
    return textResult(
      `Context "${target}" is now active: ${describeMapping(mapping)}.` +
        clearedNote +
        ` Providers not covered keep their own defaults; explicit "account" parameters and switch_account still override. ` +
        `(Shared by every conversation using this router.)`,
    );
  };

  const handleCurrentContext = (ctx: CallContext): CallToolResult => {
    ctx.outcome = "ok";
    const active = deps.state.activeContextName;
    if (active === "default") {
      return textResult(
        "Active context: default (empty — no provider mappings).",
      );
    }
    return textResult(
      `Active context: ${active} — ${describeMapping(deps.state.contextMapping(active) ?? {})}`,
    );
  };

  const handler = async (ctx: CallContext): Promise<CallToolResult> => {
    if (MANAGEMENT_TOOL_NAMES.includes(ctx.toolName)) {
      ctx.step = "management";
    }
    switch (ctx.toolName) {
      case "list_accounts":
        ctx.outcome = "ok";
        return textResult(renderAccounts());
      case "switch_account":
        return handleSwitchAccount(ctx);
      case "current_account":
        return handleCurrentAccount(ctx);
      case "list_contexts":
        return handleListContexts(ctx);
      case "switch_context":
        return handleSwitchContext(ctx);
      case "current_context":
        return handleCurrentContext(ctx);
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
      accountLabels(deps.getConfig(), tool.provider),
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
