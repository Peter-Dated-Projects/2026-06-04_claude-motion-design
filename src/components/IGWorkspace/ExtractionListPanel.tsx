import { useMemo } from "react";
import type { IGExtractionListItem } from "../../types/ig";
import { useIGStore } from "../../store/igStore";

/**
 * Left-sidebar list of past extractions for the active project -- a VS Code
 * file-tree-style rail (see src/components/CodePanel/ for the row/hover/active
 * reference). Lets the user revisit a prior brief/frames/video without re-running
 * the pipeline, turning extractions into a durable library.
 *
 * Scope: PRESENTATIONAL + DISPATCH ONLY. It reads the past-extractions list and
 * the active id from the IG store and dispatches `setActiveExtraction(id)` on
 * click. It does NOT `invoke`/`listen`, touch Tauri, or read disk -- the actual
 * enumeration of `extractions/` and the disk read of the selected extraction are
 * owned by the integration hook + backend command, which populate the store this
 * panel renders against. If the store list is still a stub (empty), this renders
 * the empty state; the integration ticket fills it.
 *
 * Thumbnails: `IGExtractionListItem.thumbnailPath` points at a local frame on
 * disk. Rendering it as an <img> requires the Tauri asset protocol
 * (`convertFileSrc`), which is out of this ticket's Tauri-free scope, so every
 * row uses a neutral leading glyph placeholder (the ticket's text-only fallback).
 * The integration pass -- which already crosses the Tauri boundary -- can swap in
 * the real thumbnail later. We never dereference the path here, so a null/absent
 * thumbnail can't crash the row.
 */

/** Newest-first by ISO `YYYY-MM-DD` date, tie-broken by id for a stable order. */
function sortNewestFirst(
  items: readonly IGExtractionListItem[],
): IGExtractionListItem[] {
  return [...items].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export default function ExtractionListPanel() {
  // Individual selectors -> stable references; selecting the whole store would
  // re-render this rail on every unrelated IG state change (frame scores, etc.).
  const extractions = useIGStore((s) => s.extractions);
  const activeExtractionId = useIGStore((s) => s.activeExtractionId);
  const setActiveExtraction = useIGStore((s) => s.setActiveExtraction);

  // The store gives no ordering guarantee, so present newest-first by date.
  const ordered = useMemo(() => sortNewestFirst(extractions), [extractions]);

  return (
    <div className="ig-extlist">
      <style>{STYLES}</style>
      <div className="ig-extlist__header">Extractions</div>

      {ordered.length === 0 ? (
        <div className="ig-extlist__empty">
          Drop a URL or video to get started.
        </div>
      ) : (
        <ul className="ig-extlist__list">
          {ordered.map((item) => {
            const isActive = item.id === activeExtractionId;
            // item.id IS the source short id (matches the extraction folder's
            // `<id>` segment, e.g. "reel_abc123"); don't invent a new field.
            const label = `${item.date} ${item.id}`;
            // Full source url (or the on-disk folder) recoverable on hover.
            const fullValue = item.sourceUrl ?? item.dir;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className={
                    "ig-extlist__row" +
                    (isActive ? " ig-extlist__row--active" : "")
                  }
                  title={fullValue}
                  aria-current={isActive ? "true" : undefined}
                  onClick={() => setActiveExtraction(item.id)}
                >
                  <span className="ig-extlist__glyph" aria-hidden="true">
                    {/* neutral film-strip placeholder; not the real thumbnail */}
                    &#9636;
                  </span>
                  <span className="ig-extlist__label">{label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* Scoped styles. This ticket touches only this file (no CSS file in scope), so
   the rail's look lives here as a one-time <style> block. Colors come from the
   app theme tokens (defined in App.css) so it tracks the file-tree rail. */
const STYLES = `
.ig-extlist {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: auto;
  background: var(--surface-alt);
  border-right: 1px solid var(--border-soft);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  user-select: none;
}
.ig-extlist__header {
  position: sticky;
  top: 0;
  padding: 6px 10px;
  color: var(--text-muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  border-bottom: 1px solid var(--border-soft);
  background: var(--surface-alt);
}
.ig-extlist__empty {
  padding: 16px 12px;
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.5;
  text-align: center;
}
.ig-extlist__list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.ig-extlist__row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text);
  text-align: left;
  padding: 4px 8px;
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
}
.ig-extlist__row:hover {
  background: var(--hover-soft);
}
.ig-extlist__row--active {
  background: var(--accent-soft);
  color: var(--accent-strong);
}
.ig-extlist__row--active:hover {
  background: var(--accent-soft-hover);
}
.ig-extlist__glyph {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1;
}
.ig-extlist__label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`;
