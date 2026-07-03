// Wires config -> downstream manager -> merge registry -> upstream server.
// Shared by `router run` and the integration tests (which inject an
// InMemoryTransport factory instead of spawning child processes).

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RouterConfig } from "./config/schema.js";
import {
  DownstreamManager,
  type TransportFactory,
} from "./downstream/manager.js";
import type { Logger } from "./log/index.js";
import {
  mergeTools,
  type LogicalTool,
  type ProviderSettings,
} from "./registry/merge.js";
import {
  loggingMiddleware,
  Metrics,
} from "./router/middleware.js";
import { SessionState } from "./state/store.js";
import {
  createUpstreamServer,
  MANAGEMENT_TOOL_NAMES,
} from "./upstream/server.js";
import { VERSION } from "./version.js";

export interface RouterApp {
  server: Server;
  manager: DownstreamManager;
  metrics: Metrics;
  state: SessionState;
  registry: { tools: LogicalTool[] };
}

export async function buildRouter(
  config: RouterConfig,
  logger: Logger,
  transportFactory?: TransportFactory,
): Promise<RouterApp> {
  const manager = new DownstreamManager(config, logger, transportFactory);
  await manager.connectAll();

  const metrics = new Metrics(VERSION);
  const state = new SessionState(config.contexts);
  const registry = { tools: [] as LogicalTool[] };

  const providerSettings: Record<string, ProviderSettings> =
    Object.fromEntries(
      Object.entries(config.providers).map(([name, provider]) => [
        name,
        { injectAccount: provider.inject_account },
      ]),
    );

  const recompute = async (): Promise<void> => {
    const downstream = await manager.listAllTools();
    const { tools, warnings } = mergeTools(
      downstream,
      providerSettings,
      MANAGEMENT_TOOL_NAMES,
    );
    for (const warning of warnings) logger.warn(warning);
    registry.tools = tools;
    logger.debug(
      `registry: ${tools.length} merged tools from ${downstream.length} downstream tools`,
    );
  };
  await recompute();

  const server = createUpstreamServer({
    config,
    state,
    manager,
    getTools: () => registry.tools,
    middlewares: [loggingMiddleware(logger), metrics.middleware()],
  });

  manager.onToolListChanged(() => {
    void recompute()
      .then(() =>
        server.notification({ method: "notifications/tools/list_changed" }),
      )
      .then(() => logger.info("downstream tools changed; registry re-aggregated"))
      .catch((err: Error) => logger.error(`re-aggregation failed: ${err.message}`));
  });

  return { server, manager, metrics, state, registry };
}
