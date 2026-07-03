// Downstream connection manager (ADR-006, ADR-007). One MCP client per
// configured account. A dead account degrades gracefully: it is reported as
// unavailable and its siblings keep working; it never takes the router down.
//
// v0.2 adds per-account health: "connected" only means the child process is
// alive, so we also remember the outcome of the most recent tool call. This
// is what lets list_accounts distinguish a live process from a working
// credential (found the hard way: an invalid Notion token connects fine and
// only fails at call time).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ToolListChangedNotificationSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RouterConfig, ServerConfig } from "../config/schema.js";
import type { Logger } from "../log/index.js";
import type { DownstreamTool } from "../registry/merge.js";
import { createTransport } from "./transports.js";
import { VERSION } from "../version.js";

export interface AccountRef {
  provider: string;
  account: string;
}

export type TransportFactory = (
  ref: AccountRef,
  server: ServerConfig,
) => Promise<Transport>;

export interface AccountStatus extends AccountRef {
  connected: boolean;
  error?: string;
  lastOkAt?: string;
  lastError?: { message: string; at: string };
}

interface ManagedAccount {
  ref: AccountRef;
  server: ServerConfig;
  client?: Client;
  error?: string;
  lastOkAt?: Date;
  lastError?: { message: string; at: Date };
}

/** Returns a failure description when a call result indicates an error.
 * Covers `isError` plus a narrow heuristic for servers that wrap HTTP
 * failures in structured non-error results (e.g. the Notion MCP server
 * returns `{"status":401,...}` with isError unset). */
function describeFailure(result: CallToolResult): string | undefined {
  const textOf = (): string =>
    (result.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join(" ");
  if (result.isError) {
    return (textOf() || "tool returned an error").slice(0, 160);
  }
  const first = result.content?.[0];
  if (
    result.content?.length === 1 &&
    first?.type === "text" &&
    first.text.length < 1024 &&
    first.text.trimStart().startsWith("{")
  ) {
    try {
      const parsed = JSON.parse(first.text) as {
        status?: unknown;
        message?: unknown;
      };
      if (typeof parsed.status === "number" && parsed.status >= 400) {
        return String(parsed.message ?? `HTTP ${parsed.status}`).slice(0, 160);
      }
    } catch {
      // Not JSON; treat as success.
    }
  }
  return undefined;
}

export class DownstreamManager {
  private readonly accounts: ManagedAccount[] = [];
  private readonly listeners: Array<() => void> = [];

  constructor(
    config: RouterConfig,
    private readonly logger: Logger,
    private readonly factory: TransportFactory = (_ref, server) =>
      createTransport(server),
  ) {
    for (const [provider, providerConfig] of Object.entries(config.providers)) {
      for (const [account, accountConfig] of Object.entries(
        providerConfig.accounts,
      )) {
        this.accounts.push({
          ref: { provider, account },
          server: accountConfig.server,
        });
      }
    }
  }

  async connectAll(): Promise<void> {
    await Promise.all(
      this.accounts.map(async (managed) => {
        const { provider, account } = managed.ref;
        try {
          const transport = await this.factory(managed.ref, managed.server);
          const client = new Client(
            { name: "mcp-router", version: VERSION },
            { capabilities: {} },
          );
          await client.connect(transport);
          client.setNotificationHandler(
            ToolListChangedNotificationSchema,
            () => {
              this.logger.debug(`${provider}/${account}: tools/list_changed`);
              for (const listener of this.listeners) listener();
            },
          );
          client.onclose = () => {
            if (managed.client === client) {
              managed.client = undefined;
              managed.error = "connection closed";
              this.logger.error(`${provider}/${account}: connection closed`);
            }
          };
          managed.client = client;
          this.logger.debug(`connected ${provider}/${account}`);
        } catch (err) {
          managed.error = (err as Error).message;
          this.logger.error(
            `failed to connect ${provider}/${account}: ${managed.error}`,
          );
        }
      }),
    );
  }

  onToolListChanged(listener: () => void): void {
    this.listeners.push(listener);
  }

  statuses(): AccountStatus[] {
    return this.accounts.map((m) => ({
      ...m.ref,
      connected: m.client !== undefined,
      ...(m.error !== undefined ? { error: m.error } : {}),
      ...(m.lastOkAt !== undefined
        ? { lastOkAt: m.lastOkAt.toISOString() }
        : {}),
      ...(m.lastError !== undefined
        ? {
            lastError: {
              message: m.lastError.message,
              at: m.lastError.at.toISOString(),
            },
          }
        : {}),
    }));
  }

  async listAllTools(): Promise<DownstreamTool[]> {
    const all: DownstreamTool[] = [];
    for (const managed of this.accounts) {
      if (!managed.client) continue;
      const { provider, account } = managed.ref;
      try {
        let cursor: string | undefined;
        do {
          const page = await managed.client.listTools(
            cursor !== undefined ? { cursor } : undefined,
          );
          for (const tool of page.tools) {
            all.push({ provider, account, tool });
          }
          cursor = page.nextCursor;
        } while (cursor !== undefined);
      } catch (err) {
        this.logger.error(
          `failed to list tools for ${provider}/${account}: ${(err as Error).message}`,
        );
      }
    }
    return all;
  }

  async callTool(
    provider: string,
    account: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const managed = this.accounts.find(
      (m) => m.ref.provider === provider && m.ref.account === account,
    );
    if (!managed) {
      throw new Error(`unknown account "${provider}/${account}"`);
    }
    if (!managed.client) {
      throw new Error(
        `account "${provider}/${account}" is unavailable` +
          (managed.error ? `: ${managed.error}` : ""),
      );
    }
    try {
      const result = (await managed.client.callTool({
        name,
        arguments: args,
      })) as CallToolResult;
      const failure = describeFailure(result);
      if (failure !== undefined) {
        managed.lastError = { message: failure, at: new Date() };
      } else {
        managed.lastOkAt = new Date();
      }
      return result;
    } catch (err) {
      managed.lastError = {
        message: (err as Error).message.slice(0, 160),
        at: new Date(),
      };
      throw err;
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      this.accounts.map(async (managed) => {
        const client = managed.client;
        managed.client = undefined; // silence onclose during shutdown
        try {
          await client?.close();
        } catch {
          // Best-effort shutdown; the process is exiting anyway.
        }
      }),
    );
  }
}
