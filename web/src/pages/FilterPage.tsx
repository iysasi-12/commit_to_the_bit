import { useMemo, useState } from "react";
import { api, errorMessage } from "../api.ts";
import { Icon } from "../icons.tsx";
import { MailList, MailSkeleton } from "../components/MailList.tsx";
import { useApp, usePlayer } from "../state.tsx";
import type { CategoriesResponse, Category, InboxItem } from "../types.ts";

function CategoryEditor() {
  const { categories, setCategories, config } = useApp();
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<CategoriesResponse>) {
    setBusy(true);
    setError(null);
    try {
      setCategories(await fn());
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function startEdit(c: Category) {
    setEditing(c.id);
    setName(c.name);
    setDesc(c.description);
  }

  if (!categories) return null;
  const full = categories.categories.length >= config.limits.maxCategories;

  return (
    <div className="card stack">
      <p className="small muted" style={{ margin: 0 }}>
        The AI uses each category's name and description to decide where an email belongs. Changing them re-sorts your inbox.
      </p>
      {categories.categories.map((c) =>
        editing === c.id ? (
          <form
            key={c.id}
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await run(() => api(`/api/categories/${c.id}`, { method: "PATCH", body: { name, description: desc } }))) setEditing(null);
            }}
          >
            <label className="field">
              Name
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={24} required />
            </label>
            <label className="field">
              What belongs here
              <textarea className="input" value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={160} />
            </label>
            <div className="row">
              <button className="btn btn-primary btn-sm" disabled={busy}>
                Save
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div key={c.id} className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
            <span className="badge" style={{ marginTop: 4 }}>
              <span className="dot" style={{ background: c.color }} />
              {c.name}
            </span>
            <span className="small muted" style={{ flex: 1, minWidth: 0 }}>
              {c.description || "No description"}
              {c.isFallback && " (catch-all)"}
            </span>
            <button className="icon-btn" onClick={() => startEdit(c)} aria-label={`Edit ${c.name}`}>
              <Icon name="edit" />
            </button>
            {!c.isFallback && (
              <button
                className="icon-btn"
                aria-label={`Delete ${c.name}`}
                onClick={() => {
                  if (confirm(`Delete the "${c.name}" category? Its emails will be re-sorted.`)) void run(() => api(`/api/categories/${c.id}`, { method: "DELETE" }));
                }}
              >
                <Icon name="trash" />
              </button>
            )}
          </div>
        ),
      )}

      <form
        className="stack"
        style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => api("/api/categories", { method: "POST", body: { name: newName, description: newDesc } }))) {
            setNewName("");
            setNewDesc("");
          }
        }}
      >
        <h3>Add a category</h3>
        <label className="field">
          Name
          <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={24} placeholder="e.g. Sports" required disabled={full} />
        </label>
        <label className="field">
          What belongs here
          <textarea
            className="input"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            maxLength={160}
            placeholder="e.g. Team practices, games, coaches and league emails"
            disabled={full}
          />
        </label>
        <div className="row">
          <button className="btn btn-primary btn-sm" disabled={busy || full}>
            <Icon name="plus" /> Add category
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              if (confirm("Reset to the default categories? Your custom ones will be removed.")) void run(() => api("/api/categories/reset", { method: "POST" }));
            }}
          >
            Reset to defaults
          </button>
        </div>
        {full && <p className="small muted">You've reached the limit of {config.limits.maxCategories} categories.</p>}
      </form>
      {error && <div className="notice notice-error">{error}</div>}
    </div>
  );
}

export function FilterPage({ onOpen }: { onOpen: (m: InboxItem) => void }) {
  const { inbox, categories, sorting, sortError, sortInbox, me } = useApp();
  const { play, state } = usePlayer();
  const [selected, setSelected] = useState<string | null>(null);
  const [manage, setManage] = useState(false);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of inbox?.messages ?? []) if (m.categoryId) map.set(m.categoryId, (map.get(m.categoryId) ?? 0) + 1);
    return map;
  }, [inbox]);

  const cats = categories?.categories ?? [];
  const current = cats.find((c) => c.id === selected) ?? null;
  const items = (inbox?.messages ?? []).filter((m) => (selected ? m.categoryId === selected : true));
  const unsorted = inbox?.unclassified ?? 0;
  const busy = state.request?.kind === "category" && state.request.categoryId === selected && (state.status === "summarizing" || state.status === "voicing");

  return (
    <div className="page">
      <h1>Filter</h1>
      <p className="lede">AI sorts your inbox into categories. Tap one to see those emails or hear a summary of just them.</p>

      <div className="card">
        <div className="row">
          <div style={{ flex: 1, minWidth: 180 }}>
            <h2 style={{ marginBottom: 2 }}>{sorting ? "Sorting your inbox…" : unsorted > 0 ? `${unsorted} email${unsorted === 1 ? "" : "s"} not sorted yet` : "Inbox sorted"}</h2>
            <p className="small muted" style={{ margin: 0 }}>
              {me.consent.accepted ? "Uses sender, subject and Gmail's preview line only." : "Sorting uses AI. You'll be asked to agree first."}
            </p>
          </div>
          <button className="btn btn-teal" onClick={() => void sortInbox()} disabled={sorting || unsorted === 0}>
            <Icon name="sparkle" /> {sorting ? "Sorting…" : "Sort with AI"}
          </button>
        </div>
        {sorting && (
          <div className="progress indeterminate" style={{ marginTop: 12 }} aria-hidden="true">
            <div />
          </div>
        )}
        {sortError && (
          <div className="notice notice-error" role="alert" style={{ marginTop: 12 }}>
            {sortError}
          </div>
        )}
      </div>

      <div className="section">
        <div className="cat-grid" role="group" aria-label="Categories">
          <button className="cat-tile" aria-pressed={selected === null} onClick={() => setSelected(null)}>
            <span className="n">{inbox?.messages.length ?? "–"}</span>
            <span>All emails</span>
          </button>
          {cats.map((c) => (
            <button key={c.id} className="cat-tile" aria-pressed={selected === c.id} onClick={() => setSelected(c.id)} style={{ borderTop: `4px solid ${c.color}` }}>
              <span className="n">{counts.get(c.id) ?? 0}</span>
              <span>{c.name}</span>
            </button>
          ))}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn btn-sm btn-ghost" onClick={() => setManage((v) => !v)} aria-expanded={manage}>
            <Icon name="edit" /> {manage ? "Done editing categories" : "Edit categories"}
          </button>
        </div>
        {manage && <CategoryEditor />}
      </div>

      {current && (
        <div className="card hero" style={{ marginBottom: 16 }}>
          <h2>{current.name}</h2>
          <p style={{ color: "var(--ink-2)" }}>
            {counts.get(current.id) ?? 0} email{(counts.get(current.id) ?? 0) === 1 ? "" : "s"} in this category.
          </p>
          <button
            className="btn btn-primary btn-lg"
            disabled={busy || (counts.get(current.id) ?? 0) === 0}
            onClick={() => void play({ kind: "category", categoryId: current.id, label: `Your ${current.name} emails` })}
          >
            <Icon name="sparkle" /> {busy ? "Working on it…" : `AI Summary of ${current.name}`}
          </button>
        </div>
      )}

      {!inbox && <MailSkeleton />}
      {inbox && items.length === 0 && (
        <div className="notice">{selected ? "No emails in this category right now." : "No emails to show."}</div>
      )}
      {inbox && items.length > 0 && <MailList items={items} categories={cats} onOpen={onOpen} />}
    </div>
  );
}
