import { describe, expect, it } from "vitest";
import type { LogicalTool } from "../src/registry/merge";
import { resolveRoute, type RouteState } from "../src/router/resolve";

const multiAccountTool: LogicalTool = {
  name: "search_pages",
  provider: "notion",
  description: "Search pages",
  inputSchema: {},
  accountParam: "account",
  readOnly: true,
  routes: { personal: "search_pages", startup: "search_pages" },
};

const emptyState: RouteState = { contextAccounts: {}, stickyAccounts: {} };

describe("resolveRoute", () => {
  it("routes on an explicit account and strips the parameter", () => {
    const decision = resolveRoute(
      multiAccountTool,
      { query: "roadmap", account: "startup" },
      emptyState,
    );
    expect(decision).toMatchObject({
      kind: "route",
      account: "startup",
      step: "explicit",
      marked: false,
      args: { query: "roadmap" },
    });
  });

  it("errors instructively on an unknown explicit account", () => {
    const decision = resolveRoute(
      multiAccountTool,
      { account: "nope" },
      emptyState,
    );
    expect(decision.kind).toBe("error");
    if (decision.kind === "error") {
      expect(decision.text).toContain('"nope"');
      expect(decision.text).toContain("personal");
      expect(decision.text).toContain("startup");
    }
  });

  it("routes via the active context, marked", () => {
    const decision = resolveRoute(
      multiAccountTool,
      { query: "x" },
      { contextAccounts: { notion: "startup" }, stickyAccounts: {} },
    );
    expect(decision).toMatchObject({
      kind: "route",
      account: "startup",
      step: "context",
      marked: true,
    });
  });

  it("explicit parameter beats the active context", () => {
    const decision = resolveRoute(
      multiAccountTool,
      { query: "x", account: "personal" },
      { contextAccounts: { notion: "startup" }, stickyAccounts: {} },
    );
    expect(decision).toMatchObject({ kind: "route", account: "personal", step: "explicit" });
  });

  it("routes via the sticky account when no context applies", () => {
    const decision = resolveRoute(
      multiAccountTool,
      { query: "x" },
      { contextAccounts: {}, stickyAccounts: { notion: "personal" } },
    );
    expect(decision).toMatchObject({
      kind: "route",
      account: "personal",
      step: "sticky",
      marked: true,
    });
  });

  it("routes a singleton without a marker", () => {
    const singleton: LogicalTool = {
      ...multiAccountTool,
      accountParam: null,
      routes: { personal: "search_pages" },
    };
    const decision = resolveRoute(singleton, { query: "x" }, emptyState);
    expect(decision).toMatchObject({
      kind: "route",
      account: "personal",
      step: "singleton",
      marked: false,
    });
  });

  it("asks when multiple accounts remain, listing labels", () => {
    const decision = resolveRoute(multiAccountTool, { query: "x" }, emptyState, {
      personal: "Personal workspace",
      startup: undefined,
    });
    expect(decision.kind).toBe("ask");
    if (decision.kind === "ask") {
      expect(decision.text).toContain('personal ("Personal workspace")');
      expect(decision.text).toContain("startup");
      expect(decision.text).toContain('"account" parameter');
    }
  });

  it("asks with configuration guidance when injection is disabled", () => {
    const noParam: LogicalTool = { ...multiAccountTool, accountParam: null };
    const decision = resolveRoute(noParam, { query: "x" }, emptyState);
    expect(decision.kind).toBe("ask");
    if (decision.kind === "ask") {
      expect(decision.text).toContain("inject_account");
    }
  });
});
