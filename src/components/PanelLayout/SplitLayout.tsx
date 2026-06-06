import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import "./SplitLayout.css";

// The three workspace panels. Same identifiers the layout tree leaves use.
export type PanelId = "terminal" | "editor" | "preview";

// The layout tree. Deliberately the SAME shape as react-mosaic's
// MosaicNode<PanelId> (leaf = panel id string; parent = a split with a first /
// second child and an optional split percentage) so App.tsx's persisted layout,
// removeLeaf/addLeaf, DEFAULT_LAYOUT and localStorage all keep working unchanged
// after we stop rendering through <Mosaic>.
export type LayoutNode = PanelId | LayoutParent;

export interface LayoutParent {
  direction: "row" | "column";
  first: LayoutNode;
  second: LayoutNode;
  splitPercentage?: number;
}

// Which child of a parent a path step descends into.
type Branch = "first" | "second";

// Where on a target leaf a drag is hovering: an outer edge band, or the center.
type DropZone = "left" | "right" | "top" | "bottom" | "center";

// Flatten the tree to the panel ids it contains, in render order. Replaces the
// getLeaves we used to import from react-mosaic.
export function getLeaves(node: LayoutNode | null): PanelId[] {
  if (node == null) return [];
  if (typeof node === "string") return [node];
  return [...getLeaves(node.first), ...getLeaves(node.second)];
}

// Immutably set splitPercentage on the parent reached by `path` from the root.
function setSplitAt(node: LayoutNode, path: Branch[], pct: number): LayoutNode {
  if (typeof node === "string") return node; // unreachable for a valid path
  if (path.length === 0) return { ...node, splitPercentage: pct };
  const [head, ...rest] = path;
  return { ...node, [head]: setSplitAt(node[head], rest, pct) };
}

// ---------------------------------------------------------------------------
// Drag-to-rearrange tree surgery. All immutable, same style as setSplitAt and
// App.tsx's removeLeaf (which we mirror here so the dragged panel's old parent
// collapses into its sibling, preserving the rest of the arrangement).
// ---------------------------------------------------------------------------

// Swap two panel ids wherever they appear in the tree, leaving structure (and
// every splitPercentage) intact. This is the "center" drop: exchange panels.
function swapLeaves(node: LayoutNode, a: PanelId, b: PanelId): LayoutNode {
  if (typeof node === "string") {
    if (node === a) return b;
    if (node === b) return a;
    return node;
  }
  return {
    ...node,
    first: swapLeaves(node.first, a, b),
    second: swapLeaves(node.second, a, b),
  };
}

// Remove a leaf, collapsing its now-only-child parent into the surviving
// sibling. Mirrors App.tsx's removeLeaf; returns null if the tree empties.
function removeLeaf(node: LayoutNode | null, id: PanelId): LayoutNode | null {
  if (node == null) return null;
  if (typeof node === "string") return node === id ? null : node;
  const first = removeLeaf(node.first, id);
  const second = removeLeaf(node.second, id);
  if (first == null) return second;
  if (second == null) return first;
  return { ...node, first, second };
}

// Build the new split that places `dragged` beside `target` per the drop zone.
// left/top -> dragged comes first; right/bottom -> dragged comes second.
function makeSplit(
  target: PanelId,
  dragged: PanelId,
  zone: Exclude<DropZone, "center">,
): LayoutParent {
  switch (zone) {
    case "left":
      return { direction: "row", first: dragged, second: target, splitPercentage: 50 };
    case "right":
      return { direction: "row", first: target, second: dragged, splitPercentage: 50 };
    case "top":
      return { direction: "column", first: dragged, second: target, splitPercentage: 50 };
    case "bottom":
      return { direction: "column", first: target, second: dragged, splitPercentage: 50 };
  }
}

// Replace the `target` leaf with a split wrapping it plus the dragged panel.
function insertBeside(
  node: LayoutNode,
  target: PanelId,
  dragged: PanelId,
  zone: Exclude<DropZone, "center">,
): LayoutNode {
  if (typeof node === "string") {
    return node === target ? makeSplit(target, dragged, zone) : node;
  }
  return {
    ...node,
    first: insertBeside(node.first, target, dragged, zone),
    second: insertBeside(node.second, target, dragged, zone),
  };
}

// Apply a completed drop to the tree. Center swaps in place; an edge first
// removes the dragged leaf (collapsing its old parent), then docks it beside
// the target. `target` always survives removeLeaf since target !== dragged.
function applyDrop(
  root: LayoutNode,
  dragged: PanelId,
  target: PanelId,
  zone: DropZone,
): LayoutNode {
  if (zone === "center") return swapLeaves(root, dragged, target);
  const without = removeLeaf(root, dragged);
  if (without == null) return root; // unreachable: target keeps the tree non-empty
  return insertBeside(without, target, dragged, zone);
}

// Classify a point inside a leaf rect: nearest edge if within the outer band,
// else center. Corners resolve to whichever edge the point is closest to.
const EDGE_BAND = 0.25;

function zoneFromRect(rect: DOMRect, x: number, y: number): DropZone {
  const dist: Record<Exclude<DropZone, "center">, number> = {
    left: (x - rect.left) / rect.width,
    right: (rect.right - x) / rect.width,
    top: (y - rect.top) / rect.height,
    bottom: (rect.bottom - y) / rect.height,
  };
  let zone: DropZone = "center";
  let min = EDGE_BAND;
  (Object.keys(dist) as Array<Exclude<DropZone, "center">>).forEach((edge) => {
    if (dist[edge] < min) {
      min = dist[edge];
      zone = edge;
    }
  });
  return zone;
}

// The fixed-position rect (viewport coords) to highlight for a given drop zone.
function highlightStyle(rect: DOMRect, zone: DropZone): CSSProperties {
  const base = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  switch (zone) {
    case "left":
      return { ...base, width: rect.width / 2 };
    case "right":
      return { ...base, left: rect.left + rect.width / 2, width: rect.width / 2 };
    case "top":
      return { ...base, height: rect.height / 2 };
    case "bottom":
      return { ...base, top: rect.top + rect.height / 2, height: rect.height / 2 };
    case "center":
      return base;
  }
}

const MIN_PCT = 8;
const MAX_PCT = 92;

const clamp = (v: number) => Math.min(MAX_PCT, Math.max(MIN_PCT, v));

// Pointer travel (px) before a header press becomes a drag, so a plain click on
// a header never starts rearranging.
const DRAG_THRESHOLD = 4;

interface DropTarget {
  panelId: PanelId;
  zone: DropZone;
}

// Header-drag API threaded down to each leaf. draggingId dims the leaf being
// dragged; the handlers start/track the gesture from the leaf's header.
interface DragApi {
  draggingId: PanelId | null;
  onHeaderPointerDown: (id: PanelId, e: ReactPointerEvent) => void;
  onHeaderPointerMove: (e: ReactPointerEvent) => void;
  onHeaderPointerUp: (e: ReactPointerEvent) => void;
  onHeaderPointerCancel: (e: ReactPointerEvent) => void;
}

interface SplitLayoutProps {
  value: LayoutNode | null;
  onChange: (next: LayoutNode | null) => void;
  renderPanel: (id: PanelId) => ReactNode;
  panelTitles: Record<PanelId, string>;
}

// Custom recursive split renderer with pointer-driven gutter resizing AND
// header drag-to-rearrange. Replaces react-mosaic's <Mosaic> renderer, which
// used react-dnd's HTML5 native-drag backend -- that breaks in WKWebView
// because the preview iframe / Monaco editor swallow native drag (and pointer)
// events as the cursor crosses them. Both interactions therefore mount a
// full-viewport fixed shield while active so the heavy children never see the
// pointer; see the shield notes in the KB.
export default function SplitLayout({
  value,
  onChange,
  renderPanel,
  panelTitles,
}: SplitLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Drag state lives here at the root (not per-ParentNode like resize) because a
  // drag spans the whole tree: it starts on one leaf's header and ends on
  // another. dragStarted gates everything after the threshold is crossed.
  const [dragId, setDragId] = useState<PanelId | null>(null);
  const [dragStarted, setDragStarted] = useState(false);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  // Leaf viewport rects, frozen at drag start. The tree doesn't change until
  // drop, so these stay valid for the whole gesture.
  const rects = useRef<Partial<Record<PanelId, DOMRect>>>({});

  // Each leaf body registers its DOM node here so we know WHERE each panel
  // should currently live. The panel itself is NOT rendered into this slot --
  // see the persistent-host machinery below for why.
  const [slots, setSlots] = useState<Partial<Record<PanelId, HTMLElement>>>({});
  const registerSlot = useCallback((id: PanelId, el: HTMLElement | null) => {
    setSlots((prev) => {
      if (el) {
        if (prev[id] === el) return prev;
        return { ...prev, [id]: el };
      }
      if (prev[id] == null) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);
  // STABLE per-id ref callback. An inline `ref={el => registerSlot(id, el)}`
  // gets a new function identity each render, so React would detach+reattach it
  // (null then node) on EVERY render -- which here churns slot state into an
  // infinite update loop. A stable callback fires only on real mount/unmount
  // (including the unmount+mount of a leaf div when the tree is rearranged).
  const slotRefs = useRef<Partial<Record<PanelId, (el: HTMLElement | null) => void>>>({});
  const getSlotRef = useCallback(
    (id: PanelId) => {
      let cb = slotRefs.current[id];
      if (!cb) {
        cb = (el) => registerSlot(id, el);
        slotRefs.current[id] = cb;
      }
      return cb;
    },
    [registerSlot],
  );

  // --- Persistent panel hosts: the panel is NEVER unmounted by layout changes -
  // Each panel is portaled into its OWN stable, never-unmounted <div> (created
  // once, kept in this ref for the life of the layout). Because the portal
  // TARGET never changes, the panel's React instance -- and with it the live
  // Claude PTY/xterm, the preview iframe, and Monaco editor state -- is never
  // torn down, no matter how the tree is dragged, RESET, nested, or how panels
  // are hidden/shown. The only thing that moves is this raw host <div>, which a
  // layout effect appendChild's into whichever leaf slot the panel occupies.
  //
  // This is strictly more robust than portaling straight into the leaf slot:
  // during a full-tree reset every leaf div unmounts at once, so the slot a
  // panel portaled into briefly became null -- unmounting the panel and
  // restarting Claude. A stable host that we merely re-parent can't hit that.
  const panelHosts = useRef<Map<PanelId, HTMLDivElement>>(new Map());
  const getPanelHost = (id: PanelId): HTMLDivElement => {
    let host = panelHosts.current.get(id);
    if (!host) {
      host = document.createElement("div");
      host.className = "split-panel-host";
      panelHosts.current.set(id, host);
    }
    return host;
  };

  // Panel ids whose portal is kept mounted. Grows monotonically: once a panel
  // has been shown we keep its instance alive even while it is hidden, so
  // re-showing it never rebuilds it (a hidden-then-shown Claude panel must keep
  // its session). A genuine reset only happens on a project switch, which the
  // panel components handle themselves -- never here.
  const [mountedIds, setMountedIds] = useState<PanelId[]>(() => getLeaves(value));
  useEffect(() => {
    setMountedIds((prev) => {
      const missing = getLeaves(value).filter((id) => !prev.includes(id));
      return missing.length ? [...prev, ...missing] : prev;
    });
  }, [value]);

  // Re-parent each panel's host into its current leaf slot, or detach it while
  // the panel is hidden (no slot). Layout phase so the move commits before
  // paint -- no flicker. appendChild relocates an already-parented node, so a
  // rearrange just moves the live DOM subtree intact.
  useLayoutEffect(() => {
    for (const id of mountedIds) {
      const host = panelHosts.current.get(id);
      if (!host) continue;
      const slot = slots[id];
      if (slot) {
        if (host.parentNode !== slot) slot.appendChild(host);
      } else if (host.parentNode) {
        host.parentNode.removeChild(host);
      }
    }
  }, [slots, mountedIds]);

  const resetDrag = () => {
    setDragId(null);
    setDragStarted(false);
    setDropTarget(null);
    startPos.current = null;
    rects.current = {};
  };

  const measureLeaves = () => {
    const map: Partial<Record<PanelId, DOMRect>> = {};
    containerRef.current
      ?.querySelectorAll<HTMLElement>("[data-panel-id]")
      .forEach((el) => {
        const id = el.dataset.panelId as PanelId;
        map[id] = el.getBoundingClientRect();
      });
    rects.current = map;
  };

  // Find the leaf under the cursor and which zone, updating the highlight. A
  // hover over the dragged panel's own leaf is not a valid target.
  const updateDropTarget = (x: number, y: number) => {
    for (const [id, rect] of Object.entries(rects.current)) {
      if (!rect) continue;
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        const pid = id as PanelId;
        setDropTarget(pid === dragId ? null : { panelId: pid, zone: zoneFromRect(rect, x, y) });
        return;
      }
    }
    setDropTarget(null);
  };

  const onHeaderPointerDown = (id: PanelId, e: ReactPointerEvent) => {
    if (value == null) return;
    e.preventDefault();
    startPos.current = { x: e.clientX, y: e.clientY };
    setDragId(id);
    setDragStarted(false);
    // Capture so the first moves route to the header even before the shield
    // mounts; released the moment the drag begins so the shield takes over.
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onHeaderPointerMove = (e: ReactPointerEvent) => {
    if (!dragId) return;
    if (!dragStarted) {
      const s = startPos.current;
      if (!s) return;
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) < DRAG_THRESHOLD) return;
      measureLeaves();
      setDragStarted(true);
      // Hand off to the shield, which covers the iframe / Monaco.
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    }
    updateDropTarget(e.clientX, e.clientY);
  };

  const commitDrop = () => {
    if (
      dragId &&
      dragStarted &&
      dropTarget &&
      value != null &&
      dropTarget.panelId !== dragId
    ) {
      onChange(applyDrop(value, dragId, dropTarget.panelId, dropTarget.zone));
    }
    resetDrag();
  };

  const onShieldPointerMove = (e: ReactPointerEvent) => {
    if (dragId && dragStarted) updateDropTarget(e.clientX, e.clientY);
  };

  // Escape aborts an in-flight drag with no layout change.
  useEffect(() => {
    if (!dragId || !dragStarted) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") resetDrag();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dragId, dragStarted]);

  // A null tree (all panels hidden) is the caller's empty-state to render.
  if (value == null) return null;

  const drag: DragApi = {
    draggingId: dragId,
    onHeaderPointerDown,
    onHeaderPointerMove,
    // Before the threshold the header still holds capture, so its pointerup
    // lands here -- a plain click ends as a clean no-op reset.
    onHeaderPointerUp: commitDrop,
    onHeaderPointerCancel: resetDrag,
  };

  const highlightRect = dropTarget ? rects.current[dropTarget.panelId] : undefined;

  return (
    <div className="split-layout" ref={containerRef}>
      <Node
        node={value}
        path={[]}
        root={value}
        onChange={onChange}
        getSlotRef={getSlotRef}
        panelTitles={panelTitles}
        drag={drag}
      />
      {/* Panels are mounted ONCE here and portaled into their stable per-panel
          host divs (which the layout effect positions into the tree). Keyed by
          id so identity -- and thus the PTY session / iframe / editor state --
          never churns when the tree shape or panel order changes. */}
      {mountedIds.map((id) => createPortal(renderPanel(id), getPanelHost(id), id))}
      {dragStarted && (
        // Full-viewport transparent shield above the preview iframe / Monaco so
        // pointermove/up keep reaching us instead of being swallowed by those
        // children. Same crux as the resize shield.
        <div
          className="split-drag-shield"
          onPointerMove={onShieldPointerMove}
          onPointerUp={commitDrop}
          onPointerCancel={resetDrag}
        />
      )}
      {dragStarted && dropTarget && highlightRect && (
        <div
          className="split-drop-zone"
          style={highlightStyle(highlightRect, dropTarget.zone)}
        />
      )}
    </div>
  );
}

interface NodeProps {
  node: LayoutNode;
  path: Branch[];
  root: LayoutNode;
  onChange: (next: LayoutNode) => void;
  // Returns a STABLE ref callback for a leaf's body DOM node; the root portals
  // the panel into it. Stable identity is required -- see getSlotRef.
  getSlotRef: (id: PanelId) => (el: HTMLElement | null) => void;
  panelTitles: Record<PanelId, string>;
  drag: DragApi;
}

function Node({ node, path, root, onChange, getSlotRef, panelTitles, drag }: NodeProps) {
  if (typeof node === "string") {
    const dragging = drag.draggingId === node;
    return (
      <div
        className={`split-leaf${dragging ? " split-leaf--dragging" : ""}`}
        data-panel-id={node}
      >
        <div
          className="split-leaf__header"
          onPointerDown={(e) => drag.onHeaderPointerDown(node, e)}
          onPointerMove={drag.onHeaderPointerMove}
          onPointerUp={drag.onHeaderPointerUp}
          onPointerCancel={drag.onHeaderPointerCancel}
        >
          {panelTitles[node]}
        </div>
        {/* Empty: the panel is portaled in from the root by registerSlot, so the
            panel instance survives this leaf being remounted on a rearrange. */}
        <div className="split-leaf__body" ref={getSlotRef(node)} />
      </div>
    );
  }
  return (
    <ParentNode
      node={node}
      path={path}
      root={root}
      onChange={onChange}
      getSlotRef={getSlotRef}
      panelTitles={panelTitles}
      drag={drag}
    />
  );
}

interface ParentNodeProps extends NodeProps {
  node: LayoutParent;
}

function ParentNode({
  node,
  path,
  root,
  onChange,
  getSlotRef,
  panelTitles,
  drag,
}: ParentNodeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);
  const isRow = node.direction === "row";
  const pct = node.splitPercentage ?? 50;

  // Translate the pointer position within THIS parent's container into a split
  // percentage and push it up the tree. Driven from both the gutter (which holds
  // pointer capture) and the shield (the fallback that catches moves over the
  // iframe if WKWebView's capture is flaky).
  const applyFromPointer = (e: ReactPointerEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const next = isRow
      ? ((e.clientX - rect.left) / rect.width) * 100
      : ((e.clientY - rect.top) / rect.height) * 100;
    onChange(setSplitAt(root, path, clamp(next)));
  };

  const onGutterPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    // Capture on the gutter so the first moves route here even before the shield
    // mounts; the shield then guarantees coverage over the heavy children.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setResizing(true);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!resizing) return;
    applyFromPointer(e);
  };

  const endResize = (e: ReactPointerEvent) => {
    if (!resizing) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setResizing(false);
  };

  const axis = isRow ? "col" : "row";

  return (
    <div
      ref={containerRef}
      className={`split-parent split-parent--${node.direction}`}
    >
      <div className="split-pane" style={{ flexGrow: pct, flexBasis: 0 }}>
        <Node
          node={node.first}
          path={[...path, "first"]}
          root={root}
          onChange={onChange}
          getSlotRef={getSlotRef}
          panelTitles={panelTitles}
          drag={drag}
        />
      </div>
      <div
        className={`split-gutter split-gutter--${axis}${resizing ? " split-gutter--active" : ""}`}
        onPointerDown={onGutterPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
      />
      <div className="split-pane" style={{ flexGrow: 100 - pct, flexBasis: 0 }}>
        <Node
          node={node.second}
          path={[...path, "second"]}
          root={root}
          onChange={onChange}
          getSlotRef={getSlotRef}
          panelTitles={panelTitles}
          drag={drag}
        />
      </div>
      {resizing && (
        // Full-viewport transparent shield ABOVE everything (incl. the preview
        // iframe / Monaco) so pointermove keeps flowing to us instead of being
        // swallowed by those children. This is the crux of the WKWebView fix.
        <div
          className={`split-shield split-shield--${axis}`}
          onPointerMove={onPointerMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
        />
      )}
    </div>
  );
}
