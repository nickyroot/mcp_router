import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { configSchema, NAME_PATTERN, type RouterConfig } from "./schema.js";
import { isSecretReference } from "./secrets.js";

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

export function defaultConfigPath(): string {
  return join(homedir(), ".config", "mcp-router", "config.yaml");
}

const SECRETISH_KEY = /(token|secret|key|password|credential)/i;

export interface LoadedConfig {
  config: RouterConfig;
  warnings: string[];
}

/** Parses and validates config text: zod schema first, then the referential
 * integrity rules of ADR-004. Throws ConfigError with every issue found. */
export function parseConfig(text: string): LoadedConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ConfigError([`YAML parse error: ${(err as Error).message}`]);
  }

  const parsed = configSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      ),
    );
  }
  const config = parsed.data;

  const issues: string[] = [];
  const warnings: string[] = [];

  for (const [provider, providerConfig] of Object.entries(config.providers)) {
    if (!NAME_PATTERN.test(provider)) {
      issues.push(
        `provider name "${provider}" is invalid (lowercase letters, digits, "-", "_")`,
      );
    }
    if (Object.keys(providerConfig.accounts).length === 0) {
      issues.push(`provider "${provider}" has no accounts`);
    }
    const seenLabels = new Map<string, string>();
    for (const [account, accountConfig] of Object.entries(
      providerConfig.accounts,
    )) {
      if (!NAME_PATTERN.test(account)) {
        issues.push(
          `account name "${provider}.${account}" is invalid (lowercase letters, digits, "-", "_")`,
        );
      }
      if (accountConfig.label !== undefined) {
        const previous = seenLabels.get(accountConfig.label);
        if (previous !== undefined) {
          issues.push(
            `provider "${provider}": label "${accountConfig.label}" is used by both "${previous}" and "${account}"`,
          );
        }
        seenLabels.set(accountConfig.label, account);
      }
      if ("command" in accountConfig.server) {
        for (const [key, value] of Object.entries(accountConfig.server.env)) {
          if (SECRETISH_KEY.test(key) && !isSecretReference(value)) {
            warnings.push(
              `${provider}.${account}: env "${key}" looks like a secret stored in plaintext; prefer \${keychain:...} or \${env:...} (ADR-009)`,
            );
          }
        }
      }
    }
  }

  for (const [contextName, mapping] of Object.entries(config.contexts)) {
    if (!NAME_PATTERN.test(contextName)) {
      issues.push(
        `context name "${contextName}" is invalid (lowercase letters, digits, "-", "_")`,
      );
    }
    for (const [provider, account] of Object.entries(mapping)) {
      const providerConfig = config.providers[provider];
      if (!providerConfig) {
        issues.push(`context "${contextName}": unknown provider "${provider}"`);
        continue;
      }
      if (!providerConfig.accounts[account]) {
        issues.push(
          `context "${contextName}": provider "${provider}" has no account "${account}"`,
        );
      }
    }
  }

  if (issues.length > 0) throw new ConfigError(issues);
  return { config, warnings };
}

export async function loadConfig(
  path: string = defaultConfigPath(),
): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new ConfigError([
      `cannot read config at ${path}: ${(err as Error).message}. Run "router init" to create one.`,
    ]);
  }
  return parseConfig(text);
}
