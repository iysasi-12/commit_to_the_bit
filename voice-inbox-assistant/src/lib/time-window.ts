/**
 * "Read the emails from the last N hours." Pure (no network), shared by the API and the UI.
 * Gmail search has no hours unit (newer_than only takes days), so the window becomes an exact
 * cutoff: `after:<unix seconds>`.
 */

export const TIME_WINDOWS = [8, 16, 48] as const;
export type TimeWindow = (typeof TIME_WINDOWS)[number];

/** A valid window in hours, or null for "newest emails, any time". */
export function parseWindow(value: unknown): TimeWindow | null {
  const n = Number(value);
  return (TIME_WINDOWS as readonly number[]).includes(n) ? (n as TimeWindow) : null;
}

/** The Gmail search query for a window, or undefined for no time limit. */
export function gmailQuery(hours: TimeWindow | null, now = Date.now()): string | undefined {
  if (!hours) return undefined;
  return `after:${Math.floor((now - hours * 3_600_000) / 1000)}`;
}

/** "the last 8 hours" — for messages like "No emails in the last 8 hours." */
export function windowLabel(hours: TimeWindow | null): string {
  return hours ? `the last ${hours} hours` : "your inbox";
}
