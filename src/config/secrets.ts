// Secrets are references, never values (ADR-009). Supported forms:
//   ${env:NAME}       -> resolved from the router's own environment
//   ${keychain:name}  -> resolved from the OS credential store (service "mcp-router")
//   anything else     -> passed through literally (validate warns on secret-ish keys)

const REFERENCE = /^\$\{(env|keychain):([^}]+)\}$/;

export const KEYCHAIN_SERVICE = "mcp-router";

export function isSecretReference(value: string): boolean {
  return REFERENCE.test(value);
}

export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

interface KeyringModule {
  Entry: new (service: string, name: string) => KeyringEntry;
}

export async function loadKeyring(): Promise<KeyringModule> {
  // Widened to `string` so tsc treats this as a fully dynamic import: the
  // package is an optional dependency and may be absent at build time.
  const moduleName: string = "@napi-rs/keyring";
  try {
    return (await import(moduleName)) as KeyringModule;
  } catch {
    throw new Error(
      `keychain references require the optional dependency "@napi-rs/keyring", which failed to load on this platform; use \${env:...} instead`,
    );
  }
}

export async function resolveEnvValue(value: string): Promise<string> {
  const match = REFERENCE.exec(value);
  if (!match) return value;
  const [, kind, name] = match;
  if (kind === "env") {
    const resolved = process.env[name];
    if (resolved === undefined) {
      throw new Error(`environment variable "${name}" is not set`);
    }
    return resolved;
  }
  const keyring = await loadKeyring();
  const password = new keyring.Entry(KEYCHAIN_SERVICE, name).getPassword();
  if (password === null) {
    throw new Error(
      `no keychain entry "${name}" for service "${KEYCHAIN_SERVICE}" (create one with: router secret set ${name})`,
    );
  }
  return password;
}

/** Resolves every reference in an env block. Values are only ever handed to
 * the child process; they must never be logged (ADR-009). */
export async function resolveEnv(
  env: Record<string, string>,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    try {
      resolved[key] = await resolveEnvValue(value);
    } catch (err) {
      throw new Error(`env "${key}": ${(err as Error).message}`);
    }
  }
  return resolved;
}
