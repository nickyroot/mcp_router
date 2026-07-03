// Route resolution (ADR-005, as amended for v0.3). Pure function: no I/O,
// fully table-testable.
//
// Resolution order, first match wins — most specific, most recent intent
// wins:
//   1. explicit `account` parameter
//   2. sticky per-provider account (switch_account — a deliberate
//      per-provider exception to whatever context is active)
//   3. active context (switch_context — the broad baseline)
//   4. singleton (exactly one configured account)
//   5. ask the model to choose (a normal, non-error result)

import type { LogicalTool } from "../registry/merge.js";

export interface RouteState {
  /** provider -> account, from the active context. */
  contextAccounts: Record<string, string>;
  /** provider -> account, from switch_account (v0.2). */
  stickyAccounts: Record<string, string>;
}

export type RouteStep = "explicit" | "context" | "sticky" | "singleton";

export type RouteDecision =
  | {
      kind: "route";
      account: string;
      physicalTool: string;
      args: Record<string, unknown>;
      step: RouteStep;
      /** True when the router chose implicitly; the result must carry a
       * visible account marker (ADR-000). */
      marked: boolean;
    }
  | { kind: "ask"; text: string }
  | { kind: "error"; text: string };

export function resolveRoute(
  tool: LogicalTool,
  rawArgs: Record<string, unknown>,
  state: RouteState,
  labels: Record<string, string | undefined> = {},
): RouteDecision {
  const args = { ...rawArgs };
  const accounts = Object.keys(tool.routes).sort();
  const describe = (account: string): string =>
    labels[account] ? `${account} ("${labels[account]}")` : account;

  const route = (
    account: string,
    step: RouteStep,
    marked: boolean,
  ): RouteDecision => ({
    kind: "route",
    account,
    physicalTool: tool.routes[account],
    args,
    step,
    marked,
  });

  // 1. Explicit parameter. Never falls through silently.
  if (tool.accountParam !== null) {
    const requested = args[tool.accountParam];
    delete args[tool.accountParam];
    if (requested !== undefined) {
      if (typeof requested !== "string" || !(requested in tool.routes)) {
        return {
          kind: "error",
          text:
            `Unknown ${tool.provider} account "${String(requested)}". ` +
            `Valid accounts: ${accounts.map(describe).join(", ")}.`,
        };
      }
      return route(requested, "explicit", false);
    }
  }

  // 2. Sticky per-provider account (beats context: it is the more specific,
  //    more recent instruction).
  const sticky = state.stickyAccounts[tool.provider];
  if (sticky !== undefined && sticky in tool.routes) {
    return route(sticky, "sticky", true);
  }

  // 3. Active context.
  const fromContext = state.contextAccounts[tool.provider];
  if (fromContext !== undefined && fromContext in tool.routes) {
    return route(fromContext, "context", true);
  }

  // 4. Singleton: nothing was chosen, so no marker.
  if (accounts.length === 1) {
    return route(accounts[0], "singleton", false);
  }

  // 5. Ask.
  const list = accounts.map(describe).join(", ");
  if (tool.accountParam !== null) {
    return {
      kind: "ask",
      text:
        `Multiple ${tool.provider} accounts are available: ${list}. ` +
        `Re-call this tool with the "${tool.accountParam}" parameter set to the account you want.`,
    };
  }
  return {
    kind: "ask",
    text:
      `Multiple ${tool.provider} accounts are available: ${list}, but the account ` +
      `parameter is disabled (inject_account: false) and no active context selects one. ` +
      `Configure a context for provider "${tool.provider}" or enable inject_account.`,
  };
}
