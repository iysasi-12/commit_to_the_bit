/** Time windows (no network): run with `npm.cmd test`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { gmailQuery, parseWindow, windowLabel } from "./time-window.ts";

test("only 8, 16 and 48 hours are accepted; anything else means no time limit", () => {
  assert.equal(parseWindow(8), 8);
  assert.equal(parseWindow("16"), 16);
  assert.equal(parseWindow(48), 48);
  for (const bad of [0, 1, 24, 72, -8, "8h", null, undefined, "", {}]) assert.equal(parseWindow(bad), null, String(bad));
});

test("the Gmail query is an exact cutoff N hours ago, in unix seconds", () => {
  const now = Date.UTC(2026, 10, 15, 18, 0, 0); // 6 PM UTC
  assert.equal(gmailQuery(8, now), `after:${Date.UTC(2026, 10, 15, 10, 0, 0) / 1000}`);
  assert.equal(gmailQuery(16, now), `after:${Date.UTC(2026, 10, 15, 2, 0, 0) / 1000}`);
  assert.equal(gmailQuery(48, now), `after:${Date.UTC(2026, 10, 13, 18, 0, 0) / 1000}`);
  assert.equal(gmailQuery(null, now), undefined);
});

test("labels for messages", () => {
  assert.equal(windowLabel(8), "the last 8 hours");
  assert.equal(windowLabel(null), "your inbox");
});
