/** Gemini quota pause (no network): run with `npm.cmd test`. */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { isModelPaused, pauseModel, resetModelPauses, retryDelayMs } from "./model-pause.ts";

// Shape of the real 429 Google returned for this project on the free tier.
const DAILY_429 =
  '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","quotaValue":"20"}]},{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"8348s"}]}}';
const MINUTE_429 = '{"error":{"code":429,"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"12.5s"}]}}';

beforeEach(() => resetModelPauses());

test("reads Google's retry delay", () => {
  assert.equal(retryDelayMs(DAILY_429), 8_348_000);
  assert.equal(retryDelayMs(MINUTE_429), 30_000, "short waits are rounded up to 30 seconds");
  assert.equal(retryDelayMs("no details"), 60_000, "unknown wait defaults to a minute");
  assert.equal(retryDelayMs('"retryDelay": "999999s"'), 86_400_000, "never more than a day");
});

test("an exhausted model is skipped until its quota resets, then tried again", () => {
  const now = 1_000_000;
  pauseModel("gemini-3.8-flash", DAILY_429, now);
  assert.equal(isModelPaused("gemini-3.8-flash", now + 1000), true);
  assert.equal(isModelPaused("gemini-3.5-flash-lite", now + 1000), false, "other models are unaffected");
  assert.equal(isModelPaused("gemini-3.8-flash", now + 8_348_000), false, "tried again after the wait");
});

test("a later, shorter pause never shortens a longer one", () => {
  const now = 5_000_000;
  pauseModel("m", DAILY_429, now);
  pauseModel("m", MINUTE_429, now + 10);
  assert.equal(isModelPaused("m", now + 60_000), true);
});
