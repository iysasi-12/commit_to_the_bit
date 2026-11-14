import type { Tab } from "./types.ts";

/** Switches to a tab even when the address bar already shows it (a plain link would do nothing then). */
export function goTo(tab: Tab): void {
  if (window.location.hash === `#${tab}`) {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = tab;
  }
}
