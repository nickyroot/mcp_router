// Local metrics persistence (ADR-011). The running router writes a small
// JSON snapshot on a throttle and at shutdown; `router stats` reads it.
// Best-effort by design: last writer wins, counters reset per process run.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "../log/index.js";
import type { Metrics, MetricsSnapshot } from "../router/middleware.js";

export function statsPath(): string {
  return join(homedir(), ".local", "state", "mcp-router", "stats.json");
}

export async function writeSnapshot(
  path: string,
  snapshot: MetricsSnapshot,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
}

export async function readSnapshot(path: string): Promise<MetricsSnapshot> {
  return JSON.parse(await readFile(path, "utf8")) as MetricsSnapshot;
}

/** Writes the snapshot every `intervalMs` while call counts change.
 * Returns a stop function that performs a final flush (call on shutdown). */
export function startSnapshotWriter(
  path: string,
  metrics: Metrics,
  logger: Logger,
  intervalMs = 15_000,
): () => Promise<void> {
  let lastWrittenTotal = -1;
  const flush = async (): Promise<void> => {
    if (metrics.totalCalls === lastWrittenTotal) return;
    lastWrittenTotal = metrics.totalCalls;
    try {
      await writeSnapshot(path, metrics.snapshot());
    } catch (err) {
      logger.debug(`stats snapshot write failed: ${(err as Error).message}`);
    }
  };
  const timer = setInterval(() => void flush(), intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await flush();
  };
}

function timeAgo(iso: string): string {
  const seconds = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function formatSnapshot(snapshot: MetricsSnapshot): string[] {
  const lines: string[] = [
    `mcp-router v${snapshot.version} stats — pid ${snapshot.pid}, ` +
      `started ${timeAgo(snapshot.startedAt)}, updated ${timeAgo(snapshot.updatedAt)}`,
    "",
  ];
  const entries = Object.entries(snapshot.counters).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (entries.length === 0) {
    lines.push("No calls recorded.");
    return lines;
  }
  const keyWidth = Math.max(
    "provider/account/tool".length,
    ...entries.map(([key]) => key.length),
  );
  lines.push(
    `${"provider/account/tool".padEnd(keyWidth)}  calls  errors  avg ms`,
  );
  for (const [key, c] of entries) {
    lines.push(
      `${key.padEnd(keyWidth)}  ${String(c.count).padStart(5)}  ` +
        `${String(c.errors).padStart(6)}  ${String(Math.round(c.totalMs / c.count)).padStart(6)}`,
    );
  }
  const steps = Object.entries(snapshot.steps)
    .sort(([, a], [, b]) => b - a)
    .map(([step, count]) => `${step} ${count}`)
    .join(", ");
  lines.push("", `route decisions: ${steps || "none"}`);
  return lines;
}
