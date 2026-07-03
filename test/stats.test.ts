import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Metrics, type CallContext } from "../src/router/middleware";
import {
  formatSnapshot,
  readSnapshot,
  writeSnapshot,
} from "../src/stats/snapshot";

const run = async (
  metrics: Metrics,
  fields: Partial<CallContext> & { toolName: string },
): Promise<void> => {
  const ctx: CallContext = { args: {}, outcome: "ok", ...fields };
  await metrics.middleware()(ctx, async () => ({ content: [] }));
};

describe("Metrics", () => {
  it("counts calls, errors, and route steps", async () => {
    const metrics = new Metrics("0.2.0");
    await run(metrics, {
      toolName: "search_pages",
      provider: "notion",
      account: "personal",
      step: "explicit",
      outcome: "ok",
    });
    await run(metrics, {
      toolName: "search_pages",
      provider: "notion",
      account: "personal",
      step: "sticky",
      outcome: "ok",
    });
    await run(metrics, {
      toolName: "search_pages",
      provider: "notion",
      outcome: "ask",
    });
    await run(metrics, {
      toolName: "create_page",
      provider: "notion",
      account: "startup",
      step: "explicit",
      outcome: "error",
    });

    const snapshot = metrics.snapshot();
    expect(snapshot.totalCalls).toBe(4);
    expect(snapshot.counters["notion/personal/search_pages"].count).toBe(2);
    expect(snapshot.counters["notion/startup/create_page"].errors).toBe(1);
    expect(snapshot.steps).toEqual({
      explicit: 1,
      sticky: 1,
      ask: 1,
      error: 1,
    });
  });
});

describe("snapshot persistence and formatting", () => {
  it("round-trips through disk and formats a table", async () => {
    const metrics = new Metrics("0.2.0");
    await run(metrics, {
      toolName: "search_pages",
      provider: "notion",
      account: "personal",
      step: "explicit",
      outcome: "ok",
    });

    const dir = await mkdtemp(join(tmpdir(), "router-stats-"));
    const path = join(dir, "stats.json");
    await writeSnapshot(path, metrics.snapshot());
    const restored = await readSnapshot(path);
    expect(restored.counters["notion/personal/search_pages"].count).toBe(1);

    const lines = formatSnapshot(restored);
    expect(lines[0]).toContain("mcp-router v0.2.0 stats");
    expect(lines.some((l) => l.includes("notion/personal/search_pages"))).toBe(true);
    expect(lines.some((l) => l.includes("route decisions: explicit 1"))).toBe(true);
  });

  it("formats an empty snapshot gracefully", () => {
    const lines = formatSnapshot(new Metrics("0.2.0").snapshot());
    expect(lines.some((l) => l.includes("No calls recorded"))).toBe(true);
  });
});
