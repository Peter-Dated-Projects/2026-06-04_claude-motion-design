import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Shared right-click context menu for the rotoscoping side panels.
 *
 * Written ONCE here and reused by both the Assets panel (T-005) and the Outputs
 * panel (T-006) -- the spec requires a single shared primitive rather than two
 * copies. It is purely presentational: it knows nothing about assets or outputs,
 * only how to draw a list of items at a cursor position and dismiss itself.
 *
 * Portal-rendered into document.body so it is never clipped by a panel's
 * `overflow: hidden` (both panels scroll their lists), and clamped to the
 * viewport so it never spills offscreen near an edge. Consumers mount it
 * conditionally at a captured client x/y (typically from an `onContextMenu`
 * event) and unmount it via `onClose`.
 */

/** One row in the menu: either a clickable action or a visual divider.
 *  A discriminated union on `type` so consumers build a flat, ordered list. */
export type RotoContextMenuItem =
  | {
      type: "action";
      label: string;
      /** Inline SVG (or any node) rendered before the label. Consumers pass
       *  their own icon element -- this component adds no icon dependency. */
      icon?: ReactNode;
      onClick: () => void;
      /** Red destructive styling (e.g. Delete). */
      danger?: boolean;
      /** Greyed-out, non-interactive. */
      disabled?: boolean;
    }
  | { type: "separator" };

export interface RotoContextMenuProps {
  /** Client x coordinate to anchor the menu's left edge at (pre-clamp). */
  x: number;
  /** Client y coordinate to anchor the menu's top edge at (pre-clamp). */
  y: number;
  items: RotoContextMenuItem[];
  /** Called when the menu should close: Escape, outside click/right-click,
   *  scroll, or after an action fires. Consumers unmount the menu here. */
  onClose: () => void;
}

/** Gap kept between the menu and the viewport edge when clamping. */
const VIEWPORT_MARGIN = 6;

export default function RotoContextMenu({
  x,
  y,
  items,
  onClose,
}: RotoContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Start at the requested point; after layout we measure and clamp so the menu
  // never overflows. Until measured we render at the raw point (one frame).
  const [pos, setPos] = useState({ x, y });

  // Clamp to the viewport once the menu has a measured size. useLayoutEffect so
  // the corrected position is committed before paint (no visible jump). Re-runs
  // when the requested point changes (consumer reopened at a new spot).
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const maxX = window.innerWidth - width - VIEWPORT_MARGIN;
    const maxY = window.innerHeight - height - VIEWPORT_MARGIN;
    setPos({
      x: Math.max(VIEWPORT_MARGIN, Math.min(x, maxX)),
      y: Math.max(VIEWPORT_MARGIN, Math.min(y, maxY)),
    });
  }, [x, y, items]);

  // Dismiss on Escape, on any pointer/context press outside the menu, and on
  // scroll (the anchor point would otherwise drift). Capture phase so we see
  // the event before it is stopped by panel handlers; pointerdown (not click)
  // so the menu closes on press, matching native context-menu behavior.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onPointerDown = (e: Event) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onScroll = () => onClose();

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("contextmenu", onPointerDown, true);
    // Scroll can originate from any scroll container, so listen in capture.
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("contextmenu", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [onClose]);

  const fireAction = useCallback(
    (item: Extract<RotoContextMenuItem, { type: "action" }>) => {
      if (item.disabled) return;
      item.onClick();
      onClose();
    },
    [onClose],
  );

  return createPortal(
    <div
      ref={menuRef}
      className="roto-ctx-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      // Swallow our own context menu so a right-click on the menu doesn't open
      // a second one (the document-level handler would also close this one).
      onContextMenu={(e) => e.preventDefault()}
    >
      <style>{STYLES}</style>
      {items.map((item, i) =>
        item.type === "separator" ? (
          <div key={`sep-${i}`} className="roto-ctx-menu__sep" role="separator" />
        ) : (
          <button
            key={`item-${i}`}
            type="button"
            role="menuitem"
            className={
              "roto-ctx-menu__item" +
              (item.danger ? " roto-ctx-menu__item--danger" : "")
            }
            disabled={item.disabled}
            onClick={() => fireAction(item)}
          >
            {item.icon ? (
              <span className="roto-ctx-menu__icon">{item.icon}</span>
            ) : null}
            <span className="roto-ctx-menu__label">{item.label}</span>
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

// Scoped styles -- same one-time <style> convention the roto panels use, so no
// CSS file is in this ticket's scope. Colors come from the app theme tokens
// (App.css); danger red matches RotoOutputsPanel's delete affordance.
const STYLES = `
.roto-ctx-menu {
  position: fixed;
  z-index: 1000;
  min-width: 160px;
  max-width: 280px;
  padding: 4px;
  background: var(--surface-alt);
  border: 1px solid var(--border-soft);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  user-select: none;
}
.roto-ctx-menu__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
  font: inherit;
  text-align: left;
  color: var(--text-muted);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}
.roto-ctx-menu__item:hover:not(:disabled) {
  color: var(--text);
  background: var(--surface);
}
.roto-ctx-menu__item:disabled {
  color: var(--text-faint);
  cursor: default;
}
.roto-ctx-menu__item--danger {
  color: #fca5a5;
}
.roto-ctx-menu__item--danger:hover:not(:disabled) {
  color: #fff;
  background: #b91c1c;
}
.roto-ctx-menu__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex: none;
}
.roto-ctx-menu__icon svg {
  width: 100%;
  height: 100%;
  display: block;
}
.roto-ctx-menu__label {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.roto-ctx-menu__sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--border-soft);
}
`;
