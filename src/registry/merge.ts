// Tool merging and collision rules (ADR-002, ADR-008).
//
// Pure module: input is the current downstream tool lists plus provider
// settings; output is the merged registry. Recomputed from scratch on every
// tools/list_changed — no incremental mutation.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface DownstreamTool {
  provider: string;
  account: string;
  tool: Tool;
}

export interface ProviderSettings {
  injectAccount: boolean;
}

export interface LogicalTool {
  /** Name exposed upstream (may be account-suffixed or provider-prefixed). */
  name: string;
  provider: string;
  description: string | undefined;
  inputSchema: Record<string, unknown>;
  /** Injected parameter name ("account" or "router_account"), or null when
   * not injected (single account, or inject_account: false). */
  accountParam: string | null;
  /** True only if every downstream variant declares readOnlyHint (ADR-008). */
  readOnly: boolean;
  /** account -> physical tool name on that account's server. */
  routes: Record<string, string>;
}

export interface MergeResult {
  tools: LogicalTool[];
  warnings: string[];
}

/** Strips cosmetic fields (description/title JSON Schema keywords) and sorts
 * keys, so schemas that differ only in wording still merge. Keys directly
 * under "properties" are property names, never keywords, and are kept. */
function normalizeSchema(node: unknown, parentKey?: string): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => normalizeSchema(item, parentKey));
  }
  if (node !== null && typeof node === "object") {
    const source = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (
        (key === "description" || key === "title") &&
        parentKey !== "properties"
      ) {
        continue;
      }
      out[key] = normalizeSchema(source[key], key);
    }
    return out;
  }
  return node;
}

export function schemaFingerprint(schema: unknown): string {
  return JSON.stringify(normalizeSchema(schema));
}

interface Candidate {
  candidateName: string;
  provider: string;
  description: string | undefined;
  baseSchema: Record<string, unknown>;
  readOnly: boolean;
  routes: Record<string, string>;
}

export function mergeTools(
  downstream: DownstreamTool[],
  providerSettings: Record<string, ProviderSettings>,
  reservedNames: string[] = [],
): MergeResult {
  const warnings: string[] = [];

  // Group by provider, then tool name.
  const byProvider = new Map<string, Map<string, DownstreamTool[]>>();
  for (const entry of downstream) {
    let byName = byProvider.get(entry.provider);
    if (!byName) {
      byName = new Map();
      byProvider.set(entry.provider, byName);
    }
    const group = byName.get(entry.tool.name);
    if (group) group.push(entry);
    else byName.set(entry.tool.name, [entry]);
  }

  const allReadOnly = (entries: DownstreamTool[]): boolean =>
    entries.every((e) => e.tool.annotations?.readOnlyHint === true);

  // Merge within each provider (ADR-008 rules 1-3).
  const candidates: Candidate[] = [];
  for (const [provider, byName] of byProvider) {
    for (const [toolName, entries] of byName) {
      const fingerprints = new Set(
        entries.map((e) => schemaFingerprint(e.tool.inputSchema)),
      );
      if (fingerprints.size === 1) {
        candidates.push({
          candidateName: toolName,
          provider,
          description: entries[0].tool.description,
          baseSchema: entries[0].tool.inputSchema as Record<string, unknown>,
          readOnly: allReadOnly(entries),
          routes: Object.fromEntries(entries.map((e) => [e.account, toolName])),
        });
      } else {
        // Schema skew across accounts: expose per-account variants.
        warnings.push(
          `tool "${toolName}" (provider "${provider}") has differing schemas across accounts ` +
            `[${entries.map((e) => e.account).join(", ")}]; exposing per-account variants (ADR-008)`,
        );
        for (const entry of entries) {
          candidates.push({
            candidateName: `${toolName}__${entry.account}`,
            provider,
            description: entry.tool.description,
            baseSchema: entry.tool.inputSchema as Record<string, unknown>,
            readOnly: allReadOnly([entry]),
            routes: { [entry.account]: toolName },
          });
        }
      }
    }
  }

  // Cross-provider and reserved-name collisions get a provider prefix.
  const nameOwners = new Map<string, Set<string>>();
  for (const reserved of reservedNames) {
    nameOwners.set(reserved, new Set(["<router>"]));
  }
  for (const candidate of candidates) {
    let owners = nameOwners.get(candidate.candidateName);
    if (!owners) {
      owners = new Set();
      nameOwners.set(candidate.candidateName, owners);
    }
    owners.add(candidate.provider);
  }

  const tools: LogicalTool[] = candidates.map((candidate) => {
    const owners = nameOwners.get(candidate.candidateName)!;
    const collides = owners.size > 1;
    const name = collides
      ? `${candidate.provider}_${candidate.candidateName}`
      : candidate.candidateName;
    if (collides && owners.has("<router>")) {
      warnings.push(
        `tool "${candidate.candidateName}" (provider "${candidate.provider}") collides with a router management tool; exposed as "${name}"`,
      );
    }

    // Inject the optional account parameter (ADR-003).
    const settings = providerSettings[candidate.provider] ?? {
      injectAccount: true,
    };
    const accounts = Object.keys(candidate.routes).sort();
    let accountParam: string | null = null;
    let inputSchema = candidate.baseSchema;
    if (settings.injectAccount && accounts.length > 1) {
      const schema = structuredClone(candidate.baseSchema);
      const properties = ((schema.properties as Record<string, unknown>) ??=
        {});
      accountParam = "account" in properties ? "router_account" : "account";
      if (accountParam === "router_account") {
        warnings.push(
          `tool "${name}" already defines an "account" property; injecting "router_account" instead (ADR-003)`,
        );
      }
      schema.type ??= "object";
      properties[accountParam] = {
        type: "string",
        enum: accounts,
        description: `Which ${candidate.provider} account to use. Omit to use the active account.`,
      };
      inputSchema = schema;
    }

    return {
      name,
      provider: candidate.provider,
      description: candidate.description,
      inputSchema,
      accountParam,
      readOnly: candidate.readOnly,
      routes: candidate.routes,
    };
  });

  tools.sort((a, b) => a.name.localeCompare(b.name));
  return { tools, warnings };
}
