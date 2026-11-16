import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import diskUsageExtension, { HOST_REFRESH_MS, CONTAINER_REFRESH_MS } from "../src/index.ts";
import { isContainer } from "../src/container.ts";

test("refresh periods are 3 minutes on host and 10 minutes in container; shutdown clears timer", async (t) => {
  assert.equal(HOST_REFRESH_MS, 180_000);
  assert.equal(CONTAINER_REFRESH_MS, 600_000);
  const container = await isContainer();
  let delay: number | undefined;
  const timer = { unref() {} };
  t.mock.method(globalThis, "setInterval", (_fn: unknown, ms: number) => { delay = ms; return timer; });
  const clear = t.mock.method(globalThis, "clearInterval", () => {});
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const api = {
    registerCommand() {},
    on(event: string, handler: (...args: unknown[]) => unknown) { handlers.set(event, handler); },
  } as unknown as ExtensionAPI;
  diskUsageExtension(api);
  const ctx = { mode: "tui", ui: { setWidget() {} } } as unknown as ExtensionContext;
  try {
    await handlers.get("session_start")!({}, ctx);
    assert.equal(delay, container ? CONTAINER_REFRESH_MS : HOST_REFRESH_MS);
  } finally {
    handlers.get("session_shutdown")!();
  }
  assert.equal(clear.mock.calls.length, 1);
  assert.equal(clear.mock.calls[0].arguments[0], timer);
});
