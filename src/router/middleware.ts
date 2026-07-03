// Middleware pipeline (ADR-010). Internal-only in v0.x; logging and metrics
// are themselves middlewares, keeping the seam honest. The empty `policy`
// slot for future approval/audit/RBAC features lives between metrics and the
// core handler.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../log/index.js";

export interface CallContext {
  toolName: string;
  args: Record<string, unknown>;
  provider?: string;
  account?: string;
  /** Which ADR-005 resolution step decided the route. */
  step?: string;
  outcome: "ok" | "ask" | "error" | "unknown-tool";
}

export type CallHandler = (ctx: CallContext) => Promise<CallToolResult>;
export type Middleware = (
  ctx: CallContext,
  next: CallHandler,
) => Promise<CallToolResult>;

export function compose(
  middlewares: Middleware[],
  handler: CallHandler,
): CallHandler {
  return middlewares.reduceRight<CallHandler>(
    (next, middleware) => (ctx) => middleware(ctx, next),
    handler,
  );
}

export function loggingMiddleware(logger: Logger): Middleware {
  return async (ctx, next) => {
    const started = Date.now();
    const result = await next(ctx);
    const elapsed = Date.now() - started;
    logger.info(
      `${ctx.provider ?? "?"}/${ctx.account ?? "?"} ${ctx.toolName} ` +
        `${ctx.outcome} ${elapsed}ms${ctx.step ? ` (route: ${ctx.step})` : ""}`,
    );
    return result;
  };
}

export interface Counter {
  count: number;
  errors: number;
  totalMs: number;
}

export interface MetricsSnapshot {
  version: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
  totalCalls: number;
  counters: Record<string, Counter>;
  /** How routes were decided: explicit/context/sticky/singleton, plus
   * "ask", "error", and "unknown-tool" outcomes (ADR-011). */
  steps: Record<string, number>;
}

export class Metrics {
  private readonly counters = new Map<string, Counter>();
  private readonly steps = new Map<string, number>();
  private readonly startedAt = new Date();
  private total = 0;

  constructor(private readonly version: string = "0") {}

  get totalCalls(): number {
    return this.total;
  }

  middleware(): Middleware {
    return async (ctx, next) => {
      const started = Date.now();
      const result = await next(ctx);
      const key = `${ctx.provider ?? "?"}/${ctx.account ?? "?"}/${ctx.toolName}`;
      const counter = this.counters.get(key) ?? {
        count: 0,
        errors: 0,
        totalMs: 0,
      };
      counter.count += 1;
      if (ctx.outcome === "error") counter.errors += 1;
      counter.totalMs += Date.now() - started;
      this.counters.set(key, counter);
      const step = ctx.outcome === "ok" ? (ctx.step ?? "n/a") : ctx.outcome;
      this.steps.set(step, (this.steps.get(step) ?? 0) + 1);
      this.total += 1;
      return result;
    };
  }

  snapshot(): MetricsSnapshot {
    return {
      version: this.version,
      pid: process.pid,
      startedAt: this.startedAt.toISOString(),
      updatedAt: new Date().toISOString(),
      totalCalls: this.total,
      counters: Object.fromEntries(this.counters),
      steps: Object.fromEntries(this.steps),
    };
  }

  summaryLines(): string[] {
    return [...this.counters.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([key, c]) =>
          `${key}: ${c.count} calls, ${c.errors} errors, avg ${Math.round(c.totalMs / c.count)}ms`,
      );
  }
}
