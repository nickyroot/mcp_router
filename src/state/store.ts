// Session state (ADR-005, ADR-006). Over stdio there is exactly one session,
// so this state is process-global — a documented limitation, mitigated by
// account markers on every implicitly routed result. The store is an
// in-memory object behind a small interface so per-session scoping over
// Streamable HTTP changes nothing here.

import type { RouterConfig } from "../config/schema.js";
import type { RouteState } from "../router/resolve.js";

export class SessionState {
  /** The implicit empty "default" context is always active at startup; a
   * user-defined context literally named "default" is honored (ADR-005). */
  private activeContext = "default";

  /** provider -> account, set by switch_account. */
  readonly stickyAccounts: Record<string, string> = {};

  constructor(private contexts: Record<string, Record<string, string>>) {}

  get activeContextName(): string {
    return this.activeContext;
  }

  contextNames(): string[] {
    return Object.keys(this.contexts);
  }

  contextMapping(name: string): Record<string, string> | undefined {
    return this.contexts[name];
  }

  /** Activates a context. Clears sticky overrides for the providers the
   * context covers: entering a context is a reset of per-provider
   * exceptions (ADR-005 amendment). Returns the providers that were
   * cleared, for visibility. */
  switchContext(name: string): string[] {
    if (name !== "default" && !(name in this.contexts)) {
      throw new Error(
        `unknown context "${name}"; configured contexts: ${
          this.contextNames().join(", ") || "(none)"
        }`,
      );
    }
    this.activeContext = name;
    const cleared: string[] = [];
    for (const provider of Object.keys(this.contexts[name] ?? {})) {
      if (provider in this.stickyAccounts) {
        delete this.stickyAccounts[provider];
        cleared.push(provider);
      }
    }
    return cleared;
  }

  setStickyAccount(provider: string, account: string): void {
    this.stickyAccounts[provider] = account;
  }

  clearStickyAccount(provider: string): void {
    delete this.stickyAccounts[provider];
  }

  /** Reconciles state with a reloaded config (v0.3 hot reload): stale
   * references must be cleared loudly, never routed to silently (ADR-000).
   * Returns human-readable warnings for the log. */
  reconcile(config: RouterConfig): string[] {
    const warnings: string[] = [];
    this.contexts = config.contexts;
    if (
      this.activeContext !== "default" &&
      !(this.activeContext in this.contexts)
    ) {
      warnings.push(
        `active context "${this.activeContext}" no longer exists after reload; reverting to default`,
      );
      this.activeContext = "default";
    }
    for (const [provider, account] of Object.entries(this.stickyAccounts)) {
      if (!config.providers[provider]?.accounts[account]) {
        warnings.push(
          `active ${provider} account "${account}" no longer exists after reload; ambiguous calls will ask`,
        );
        delete this.stickyAccounts[provider];
      }
    }
    return warnings;
  }

  routeState(): RouteState {
    return {
      contextAccounts: this.contexts[this.activeContext] ?? {},
      stickyAccounts: this.stickyAccounts,
    };
  }
}
