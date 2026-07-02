// All human-facing output goes to stderr: over stdio, stdout belongs to the
// MCP protocol (ADR-011).

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createLogger(level: LogLevel = "info"): Logger {
  const write = (lvl: LogLevel, message: string): void => {
    if (ORDER[lvl] < ORDER[level]) return;
    const ts = new Date().toTimeString().slice(0, 8);
    const prefix = lvl === "info" ? "" : `${lvl.toUpperCase()} `;
    process.stderr.write(`[${ts}] ${prefix}${message}\n`);
  };
  return {
    debug: (m) => write("debug", m),
    info: (m) => write("info", m),
    warn: (m) => write("warn", m),
    error: (m) => write("error", m),
  };
}

export const silentLogger: Logger = createLogger("silent");
