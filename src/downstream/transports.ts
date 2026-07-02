import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerConfig } from "../config/schema.js";
import { resolveEnv } from "../config/secrets.js";

/** Default transport factory (ADR-006): stdio child process for local
 * servers, Streamable HTTP for remote ones. Secret references resolve here,
 * at spawn time, straight into the child's environment (ADR-009). */
export async function createTransport(server: ServerConfig): Promise<Transport> {
  if ("url" in server) {
    return new StreamableHTTPClientTransport(new URL(server.url));
  }
  const env = await resolveEnv(server.env);
  return new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: { ...getDefaultEnvironment(), ...env },
  });
}
