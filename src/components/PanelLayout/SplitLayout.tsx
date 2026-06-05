import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
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

const MIN_PCT = 8;
const MAX_PCT = 92;

const clamp = (v: number) => Math.min(MAX_PCT, Math.max(MIN_PCT, v));

interface SplitLayoutProps {
  value: LayoutNode | null;
  onChange: (next: LayoutNode | null) => void;
  renderPanel: (id: PanelId) => ReactNode;
  panelTitles: Record<PanelId, string>;
}

// Custom recursive split renderer with pointer-driven gutter resizing. Replaces
// react-mosaic's <Mosaic> renderer, which used react-dnd's HTML5 native-drag
// backend -- that breaks in WKWebView because the preview iframe / Monaco editor
// swallow native drag events as the cursor crosses them. Pointer events plus a
// full-viewport shield (mounted while resizing) sidestep that entirely.
//
// RENDER + RESIZE only. Drag-to-rearrange lives in a later ticket.
export default function SplitLayout({
  value,
  onChange,
  renderPanel,
  panelTitles,
}: SplitLayoutProps) {
  // A null tree (all panels hidden) is the caller's empty-state to render.
  if (value == null) return null;
  return (
    <div className="split-layout">
      <Node
        node={value}
        path={[]}
        root={value}
        onChange={onChange}
        renderPanel={renderPanel}
        panelTitles={panelTitles}
      />
    </div>
  );
}

interface NodeProps {
  node: LayoutNode;
  path: Branch[];
  root: LayoutNode;
  onChange: (next: LayoutNode) => void;
  renderPanel: (id: PanelId) => ReactNode;
  panelTitles: Record<PanelId, string>;
}

function Node({ node, path, root, onChange, renderPanel, panelTitles }: NodeProps) {
  if (typeof node === "string") {
    return (
      <div className="split-leaf">
        <div className="split-leaf__header">{panelTitles[node]}</div>
        <div className="split-leaf__body">{renderPanel(node)}</div>
      </div>
    );
  }
  return (
    <ParentNode
      node={node}
      path={path}
      root={root}
      onChange={onChange}
      renderPanel={renderPanel}
      panelTitles={panelTitles}
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
  renderPanel,
  panelTitles,
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
          renderPanel={renderPanel}
          panelTitles={panelTitles}
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
          renderPanel={renderPanel}
          panelTitles={panelTitles}
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
