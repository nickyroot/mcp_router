// Session state (ADR-005, ADR-006). Over stdio there is exactly one session,
// so this state is process-global — a documented limitation, mitigated by
// account markers on every implicitly routed result. The store is an
// in-memory object behind a small interface so per-session scoping over
// Streamable HTTP (v0.2+) changes nothing here.

import type { RouteState } from "../router/resolve.js";

export class SessionState {
  /** The implicit empty "default" context is always active at startup; a
   * user-defined context literally named "default" is honored (ADR-005). */
  private activeContext = "default";

  /** provider -> account, set by switch_account. */
  readonly stickyAccounts: Record<string, string> = {};

  setStickyAccount(provider: string, account: string): void {
    this.stickyAccounts[provider] = account;
  }

  clearStickyAccount(provider: string): void {
    delete this.stickyAccounts[provider];
  }

  constructor(
    private readonly contexts: Record<string, Record<string, string>>,
  ) {}

  get activeContextName(): string {
    return this.activeContext;
  }

  /** v0.3 exposes this via switch_context; present now so the resolver and
   * state shape never change. */
  switchContext(name: string): void {
    if (name !== "default" && !(name in this.contexts)) {
      throw new Error(
        `unknown context "${name}"; configured contexts: ${
          Object.keys(this.contexts).join(", ") || "(none)"
        }`,
      );
    }
    this.activeContext = name;
  }

  routeState(): RouteState {
    return {
      contextAccounts: this.contexts[this.activeContext] ?? {},
      stickyAccounts: this.stickyAccounts,
    };
  }
}
