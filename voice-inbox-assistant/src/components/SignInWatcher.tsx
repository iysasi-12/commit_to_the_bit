"use client";

import { useEffect } from "react";

/**
 * Inside the Chrome side panel, Google sign-in has to happen in a new tab. This notices when
 * that sign-in has finished and reloads the panel by itself, so nobody has to refresh it.
 * It polls only while embedded (the side panel); in a normal tab it just checks on focus.
 */
export function SignInWatcher() {
  useEffect(() => {
    let done = false;
    const check = async () => {
      if (done) return;
      try {
        const session = (await fetch("/api/auth/session", { cache: "no-store" }).then((r) => r.json())) as { user?: unknown } | null;
        if (session?.user) {
          done = true;
          window.location.reload();
        }
      } catch {
        // Offline for a moment: try again on the next tick.
      }
    };
    const embedded = window.self !== window.top;
    const timer = embedded ? window.setInterval(() => void check(), 3000) : undefined;
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      if (timer) window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);
  return null;
}
