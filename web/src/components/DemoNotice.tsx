import { useApp } from "../state.tsx";

/** Names every part of the app that is a stand-in rather than the real service. */
export function DemoNotice() {
  const { me, config } = useApp();
  const parts: string[] = [];
  if (me.isDemo) parts.push("a sample inbox");
  if (config.services.ai === "demo") parts.push("summaries without AI");
  if (config.services.voice === "demo") parts.push("placeholder audio");
  if (parts.length === 0) return null;
  const keysMissing = config.services.ai === "demo" || config.services.voice === "demo";
  return (
    <div className="notice notice-warn small" role="note" style={{ margin: "12px 0" }}>
      <strong>Demo mode</strong>
      Using {parts.join(", ")}.{keysMissing ? " Add API keys in .env to switch these to the real services." : " AI summaries and voices are real."}
    </div>
  );
}
