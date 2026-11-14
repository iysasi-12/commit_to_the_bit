import type { Category, InboxItem } from "../types.ts";
import { avatarColor, initials, shortTime } from "../util.ts";

export function MailList({ items, categories, onOpen }: { items: InboxItem[]; categories: Category[]; onOpen: (m: InboxItem) => void }) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  return (
    <ul className="mail-list">
      {items.map((m) => {
        const cat = m.categoryId ? byId.get(m.categoryId) : undefined;
        return (
          <li key={m.id}>
            <button className={`mail-row${m.unread ? " unread" : ""}`} onClick={() => onOpen(m)}>
              <span className="avatar" style={{ background: avatarColor(m.fromEmail || m.fromName) }} aria-hidden="true">
                {initials(m.fromName)}
              </span>
              <span className="mail-body">
                <span className="mail-top">
                  <span className="mail-from">
                    {m.unread && <span className="sr-only">Unread. </span>}
                    {m.fromName}
                  </span>
                  <span className="mail-time">{shortTime(m.date)}</span>
                </span>
                <span className="mail-subject" style={{ display: "block" }}>
                  {m.subject}
                </span>
                <span className="mail-snippet" style={{ display: "block" }}>
                  {m.snippet}
                </span>
                {cat && (
                  <span className="mail-meta" style={{ display: "block" }}>
                    <span className="badge">
                      <span className="dot" style={{ background: cat.color }} />
                      {cat.name}
                    </span>
                  </span>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function MailSkeleton() {
  return (
    <div className="card stack" aria-label="Loading emails">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="stack" style={{ gap: 6 }}>
          <div className="skeleton" style={{ width: "40%" }} />
          <div className="skeleton" style={{ width: "85%" }} />
        </div>
      ))}
    </div>
  );
}
