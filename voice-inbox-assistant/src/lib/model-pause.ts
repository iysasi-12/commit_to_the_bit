/**
 * Remembers when a Gemini model ran out of quota, so the app goes straight to the fallback model
 * instead of spending a request (and a few seconds) per email on a model that will refuse.
 * Pure (no network), so it can be unit-tested.
 *
 * On the free tier the main model allows only a few requests a day; Google's 429 answer says how
 * long to wait, e.g. "retryDelay": "8348s" with quota "GenerateRequestsPerDayPerProjectPerModel".
 */

const MIN_PAUSE_MS = 30_000;
const MAX_PAUSE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PAUSE_MS = 60_000;

const pausedUntil = new Map<string, number>();

/** How long Google asked us to wait, from the text of a 429 error. */
export function retryDelayMs(errorText: string): number {
  const seconds = Number(errorText.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/)?.[1]);
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_PAUSE_MS;
  return Math.min(MAX_PAUSE_MS, Math.max(MIN_PAUSE_MS, ms));
}

export function pauseModel(model: string, errorText: string, now = Date.now()): number {
  const until = now + retryDelayMs(errorText);
  pausedUntil.set(model, Math.max(until, pausedUntil.get(model) ?? 0));
  return until;
}

export function isModelPaused(model: string, now = Date.now()): boolean {
  const until = pausedUntil.get(model);
  if (until === undefined) return false;
  if (now >= until) {
    pausedUntil.delete(model);
    return false;
  }
  return true;
}

export function resetModelPauses(): void {
  pausedUntil.clear();
}
