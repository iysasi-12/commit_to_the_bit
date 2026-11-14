import { Icon } from "../icons.tsx";
import { MailList, MailSkeleton } from "../components/MailList.tsx";
import { useApp, usePlayer } from "../state.tsx";
import type { InboxItem } from "../types.ts";
import { greeting } from "../util.ts";

export function InboxPage({ onOpen }: { onOpen: (m: InboxItem) => void }) {
  const { me, inbox, inboxError, inboxLoading, loadInbox, categories } = useApp();
  const { play, state } = usePlayer();
  const count = Math.min(me.settings.summaryCount, inbox?.messages.length ?? me.settings.summaryCount);
  const unread = inbox?.messages.filter((m) => m.unread).length ?? 0;
  const busy = state.request?.kind === "inbox" && (state.status === "summarizing" || state.status === "voicing");

  return (
    <div className="page">
      <h1>{greeting(me.name)}</h1>
      <p className="lede">
        {inbox ? (
          <>
            {inbox.messages.length} recent emails{unread > 0 ? `, ${unread} unread` : ""}.
          </>
        ) : (
          "Loading your inbox…"
        )}
      </p>

      <div className="card hero">
        <h2>Your inbox, read aloud</h2>
        <p className="muted" style={{ color: "var(--ink-2)" }}>
          Hear a quick AI summary of your latest {count} emails: what needs a reply, what's due, and what can wait.
        </p>
        <button
          className="btn btn-primary btn-lg"
          onClick={() => void play({ kind: "inbox", label: `Your latest ${count} emails` })}
          disabled={busy || !inbox || inbox.messages.length === 0}
        >
          <Icon name="sparkle" /> {busy ? "Working on it…" : "AI Summary"}
        </button>
      </div>

      <div className="section">
        <div className="section-head">
          <h2>Inbox</h2>
          <button className="btn btn-sm" onClick={() => void loadInbox(true)} disabled={inboxLoading}>
            <Icon name="refresh" /> {inboxLoading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        {inboxError && (
          <div className="notice notice-error" role="alert" style={{ marginBottom: 12 }}>
            {inboxError}
          </div>
        )}
        {!inbox && !inboxError && <MailSkeleton />}
        {inbox && inbox.messages.length === 0 && <div className="notice">Your inbox is empty. Nice.</div>}
        {inbox && inbox.messages.length > 0 && <MailList items={inbox.messages} categories={categories?.categories ?? []} onOpen={onOpen} />}
      </div>
    </div>
  );
}
