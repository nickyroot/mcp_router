#!/usr/bin/env node
// CLI: init / validate / run / secret (ADR-007, ADR-009, ADR-011).

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { stringify as stringifyYaml } from "yaml";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildRouter } from "../app.js";
import {
  ConfigError,
  defaultConfigPath,
  loadConfig,
} from "../config/load.js";
import { KEYCHAIN_SERVICE, loadKeyring } from "../config/secrets.js";
import { NAME_PATTERN } from "../config/schema.js";
import { createLogger, type LogLevel } from "../log/index.js";
import { VERSION } from "../version.js";
import { SAMPLE_CONFIG } from "./sample-config.js";

const HELP = `mcp-router v${VERSION} — one MCP server, unlimited accounts

Usage:
  router init [--import <claude_desktop_config.json>] [--force] [--config <path>]
  router validate [--config <path>]
  router run [--config <path>] [--log-level debug|info|warn|error]
  router secret set <name>    store a keychain entry for \${keychain:<name>}
  router secret rm <name>     remove a keychain entry

Config defaults to ${defaultConfigPath()}
`;

const out = (message: string): void => void process.stderr.write(`${message}\n`);

function commandOnPath(command: string): boolean {
  if (command.includes("/") || isAbsolute(command)) return existsSync(command);
  const paths = (process.env.PATH ?? "").split(delimiter);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  return paths.some((p) =>
    extensions.some((ext) => p !== "" && existsSync(join(p, command + ext))),
  );
}

interface ClaudeDesktopConfig {
  mcpServers?: Record<
    string,
    { command?: string; args?: string[]; env?: Record<string, string>; url?: string }
  >;
}

/** Converts a claude_desktop_config.json into router config: each entry
 * becomes a provider with a single "default" account (ADR-007). */
async function importClaudeDesktopConfig(path: string): Promise<string> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as ClaudeDesktopConfig;
  const entries = Object.entries(parsed.mcpServers ?? {});
  if (entries.length === 0) {
    throw new Error(`no mcpServers found in ${path}`);
  }
  const providers: Record<string, unknown> = {};
  for (const [rawName, server] of entries) {
    let name = rawName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+/, "");
    if (!NAME_PATTERN.test(name)) name = `server-${Object.keys(providers).length}`;
    while (name in providers) name = `${name}-2`;
    providers[name] = {
      accounts: {
        default: {
          server: server.url
            ? { url: server.url }
            : {
                command: server.command ?? "",
                args: server.args ?? [],
                env: server.env ?? {},
              },
        },
      },
    };
  }
  return stringifyYaml({ providers });
}

async function cmdInit(opts: {
  config?: string;
  import?: string;
  force?: boolean;
}): Promise<void> {
  const path = opts.config ?? defaultConfigPath();
  if (existsSync(path) && !opts.force) {
    throw new Error(`${path} already exists (use --force to overwrite)`);
  }
  const content = opts.import
    ? await importClaudeDesktopConfig(opts.import)
    : SAMPLE_CONFIG;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  out(`Wrote ${path}`);
  if (opts.import) {
    out(
      `Imported ${opts.import}. Review the file: rename providers/accounts, add labels, ` +
        `and move any plaintext secrets to \${keychain:...} or \${env:...} (ADR-009).`,
    );
  } else {
    out(`Edit it to describe your providers and accounts, then run "router validate".`);
  }
}

async function cmdValidate(opts: { config?: string }): Promise<void> {
  const path = opts.config ?? defaultConfigPath();
  const { config, warnings } = await loadConfig(path);

  for (const warning of warnings) out(`warning: ${warning}`);
  for (const [provider, providerConfig] of Object.entries(config.providers)) {
    for (const [account, accountConfig] of Object.entries(providerConfig.accounts)) {
      if (
        "command" in accountConfig.server &&
        !commandOnPath(accountConfig.server.command)
      ) {
        out(
          `warning: ${provider}.${account}: command "${accountConfig.server.command}" not found on PATH`,
        );
      }
    }
  }

  const providerCount = Object.keys(config.providers).length;
  const accountCount = Object.values(config.providers).reduce(
    (sum, p) => sum + Object.keys(p.accounts).length,
    0,
  );
  const contextCount = Object.keys(config.contexts).length;
  out(
    `Config OK: ${providerCount} provider(s), ${accountCount} account(s), ${contextCount} context(s) — ${path}`,
  );
}

async function cmdRun(opts: {
  config?: string;
  "log-level"?: string;
}): Promise<void> {
  const logger = createLogger((opts["log-level"] as LogLevel) ?? "info");
  const { config, warnings } = await loadConfig(opts.config ?? defaultConfigPath());
  for (const warning of warnings) logger.warn(warning);

  const app = await buildRouter(config, logger);
  const statuses = app.manager.statuses();
  const connected = statuses.filter((s) => s.connected).length;
  logger.info(
    `mcp-router v${VERSION}: ${connected}/${statuses.length} accounts connected, ` +
      `${app.registry.tools.length} tools exposed`,
  );

  const shutdown = async (): Promise<void> => {
    for (const line of app.metrics.summaryLines()) logger.info(`stats: ${line}`);
    await app.manager.closeAll();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.server.connect(new StdioServerTransport());
  logger.info("listening on stdio");
}

async function cmdSecret(action: string | undefined, name: string | undefined): Promise<void> {
  if ((action !== "set" && action !== "rm") || !name) {
    throw new Error(`usage: router secret set|rm <name>`);
  }
  const keyring = await loadKeyring();
  const entry = new keyring.Entry(KEYCHAIN_SERVICE, name);
  if (action === "rm") {
    out(entry.deletePassword() ? `Removed keychain entry "${name}".` : `No keychain entry "${name}".`);
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const value = (await rl.question(`Value for "${name}" (input is echoed): `)).trim();
  rl.close();
  if (value === "") throw new Error("empty value; nothing stored");
  entry.setPassword(value);
  out(`Stored keychain entry "${name}" — reference it as \${keychain:${name}}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      config: { type: "string" },
      "log-level": { type: "string" },
      import: { type: "string" },
      force: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    allowPositionals: true,
  });

  if (values.version) {
    out(`mcp-router v${VERSION}`);
    return;
  }
  const command = positionals[0];
  if (values.help || command === undefined || command === "help") {
    out(HELP);
    return;
  }

  switch (command) {
    case "init":
      return cmdInit(values);
    case "validate":
      return cmdValidate(values);
    case "run":
      return cmdRun(values);
    case "secret":
      return cmdSecret(positionals[1], positionals[2]);
    default:
      throw new Error(`unknown command "${command}"\n\n${HELP}`);
  }
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    out(err.message);
  } else {
    out(`error: ${(err as Error).message}`);
  }
  process.exit(1);
});
