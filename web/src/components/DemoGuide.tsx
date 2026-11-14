import { useState } from "react";
import { Icon } from "../icons.tsx";
import { goTo } from "../nav.ts";
import type { Tab } from "../types.ts";

const KEY = "inbox-voice-demo-guide-hidden";

function readHidden(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

const STEPS: Array<{ text: string; href?: string; link?: string }> = [
  { text: "Tap AI Summary above to hear your inbox read aloud." },
  { text: "Switch the voice with the Read by menu, then tap AI Summary again.", },
  { text: "Add your own voice: read a short script for about a minute.", href: "#voice", link: "Open Voice" },
  { text: "Hear just one category, like School or Transactions.", href: "#filter", link: "Open Filter" },
  { text: "See how it would look inside your mail app.", href: "#gmail", link: "Open Gmail view" },
];

/** A short checklist shown to demo accounts so a presenter can follow the flow. */
export function DemoGuide() {
  const [hidden, setHidden] = useState(readHidden);
  if (hidden) return null;
  return (
    <section className="card demo-guide" aria-labelledby="demo-guide-h" style={{ marginTop: 14 }}>
      <div className="row">
        <h2 id="demo-guide-h" style={{ flex: 1, margin: 0 }}>
          Demo tour
        </h2>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => {
            setHidden(true);
            try {
              window.localStorage.setItem(KEY, "1");
            } catch {
              // fine: it just shows again next time
            }
          }}
        >
          Hide
        </button>
      </div>
      <ol className="demo-steps">
        {STEPS.map((s, i) => (
          <li key={i}>
            <span>{s.text}</span>
            {s.href && (
              <a
                className="btn btn-sm"
                href={s.href}
                onClick={(e) => {
                  e.preventDefault();
                  goTo(s.href!.slice(1) as Tab);
                }}
              >
                {s.link} <Icon name="forward" />
              </a>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
