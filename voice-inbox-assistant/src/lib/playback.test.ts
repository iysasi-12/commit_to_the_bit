/** Reading modes and pause levels (no browser): run with `npm.cmd test`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { afterEnded, DEFAULT_PAUSE, PAUSE_MS, parseMode, parsePause } from "./playback.ts";

test("exactly three pause levels: Slow keeps the measured pause, Medium is half, Fast a quarter", () => {
  assert.deepEqual(PAUSE_MS, { slow: 1400, medium: 700, fast: 350 });
  assert.equal(PAUSE_MS.medium, PAUSE_MS.slow / 2);
  assert.equal(PAUSE_MS.fast, PAUSE_MS.slow / 4);
});

test("Medium is the default when nothing (or something invalid) is saved", () => {
  assert.equal(DEFAULT_PAUSE, "medium");
  for (const v of [undefined, null, "", "turbo", 3]) assert.equal(parsePause(v), "medium");
  assert.equal(parsePause("fast"), "fast");
});

test("All at once advances after the chosen pause; the last email just finishes", () => {
  assert.deepEqual(afterEnded("all", false, "slow"), { kind: "advance", delayMs: 1400 });
  assert.deepEqual(afterEnded("all", false, "medium"), { kind: "advance", delayMs: 700 });
  assert.deepEqual(afterEnded("all", false, "fast"), { kind: "advance", delayMs: 350 });
  assert.deepEqual(afterEnded("all", true, "fast"), { kind: "finished" });
});

test("One at a time ALWAYS waits for the person, whatever the pause setting", () => {
  for (const pause of ["slow", "medium", "fast"] as const) {
    assert.deepEqual(afterEnded("one", false, pause), { kind: "wait-for-user" });
    assert.deepEqual(afterEnded("one", true, pause), { kind: "wait-for-user" });
  }
});

test("reading mode: saved value, else the old 'Read all at once' checkbox, else All at once", () => {
  assert.equal(parseMode("one"), "one");
  assert.equal(parseMode(undefined, false), "one");
  assert.equal(parseMode(undefined, true), "all");
  assert.equal(parseMode("weird"), "all");
});
