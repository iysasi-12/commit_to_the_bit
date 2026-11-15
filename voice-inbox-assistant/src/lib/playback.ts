/**
 * Reading modes and the pause between emails (pure, no browser APIs).
 *
 * Measured on 2026-11-15 before this setting existed: in "Read all at once" the silence between
 * two emails was 1,350–1,500 ms, and all of it was waiting for the next email's audio to be made
 * (ElevenLabs answered in 1.3–2.3 s); there was no intentional pause in the code. The app now
 * prepares the next email's audio while the current one plays, so that loading wait is gone and
 * the silence is exactly the chosen pause:
 *   Slow   = 1,400 ms (the pause people were used to)
 *   Medium =   700 ms (about half; the default)
 *   Fast   =   350 ms (about a quarter)
 * The pause only changes the silence between emails, never the voice's speaking rate.
 */

export type ReadingMode = "all" | "one";
export type PauseLevel = "slow" | "medium" | "fast";

export const PAUSE_LEVELS: PauseLevel[] = ["slow", "medium", "fast"];
export const PAUSE_MS: Record<PauseLevel, number> = { slow: 1400, medium: 700, fast: 350 };
export const DEFAULT_PAUSE: PauseLevel = "medium";
export const PAUSE_LABEL: Record<PauseLevel, string> = { slow: "Slow", medium: "Medium", fast: "Fast" };

export function parsePause(value: unknown): PauseLevel {
  return PAUSE_LEVELS.includes(value as PauseLevel) ? (value as PauseLevel) : DEFAULT_PAUSE;
}

export function parseMode(value: unknown, legacyContinuous?: unknown): ReadingMode {
  if (value === "all" || value === "one") return value;
  // Older saves stored a "Read all at once" checkbox.
  return legacyContinuous === false ? "one" : "all";
}

export type AfterEnded = { kind: "advance"; delayMs: number } | { kind: "wait-for-user" } | { kind: "finished" };

/**
 * What happens when an email's audio finishes. One at a time ALWAYS waits for Delete, Next or
 * Reorganize, whatever the pause setting; the pause only applies to All at once.
 */
export function afterEnded(mode: ReadingMode, atEnd: boolean, pause: PauseLevel): AfterEnded {
  if (mode === "one") return { kind: "wait-for-user" };
  if (atEnd) return { kind: "finished" };
  return { kind: "advance", delayMs: PAUSE_MS[pause] };
}
