import { z } from "zod";

/** Provider, account, and context names must be safe to embed in tool names. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export const stdioServerSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
  })
  .strict();

export const httpServerSchema = z
  .object({
    url: z.string().url(),
  })
  .strict();

/** Matches the command/args/env shape of claude_desktop_config.json (ADR-004). */
export const serverSchema = z.union([stdioServerSchema, httpServerSchema]);

export const accountSchema = z
  .object({
    server: serverSchema,
    label: z.string().optional(),
  })
  .strict();

export const providerSchema = z
  .object({
    accounts: z.record(accountSchema),
    inject_account: z.boolean().default(true),
  })
  .strict();

export const configSchema = z
  .object({
    providers: z.record(providerSchema),
    contexts: z.record(z.record(z.string())).default({}),
  })
  .strict();

export type StdioServerConfig = z.infer<typeof stdioServerSchema>;
export type HttpServerConfig = z.infer<typeof httpServerSchema>;
export type ServerConfig = z.infer<typeof serverSchema>;
export type AccountConfig = z.infer<typeof accountSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;
export type RouterConfig = z.infer<typeof configSchema>;

export function accountLabels(
  config: RouterConfig,
  provider: string,
): Record<string, string | undefined> {
  const accounts = config.providers[provider]?.accounts ?? {};
  return Object.fromEntries(
    Object.entries(accounts).map(([name, account]) => [name, account.label]),
  );
}
