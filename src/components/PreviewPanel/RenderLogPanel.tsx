import { useEffect, useRef } from "react";
import {
  useRenderLogStore,
  type RenderLogEntry,
  type RenderLogLevel,
} from "../../store/renderLogStore";

// Level -> text color. Errors red, warnings amber, info muted -- consistent with the
// light preview theme (the red error strip uses the same #b71c1c family).
const LEVEL_COLOR: Record<RenderLogLevel, string> = {
  error: "#c5221f",
  warn: "#b8860b",
  info: "#6a6a6a",
};

const STAGE_LABEL: Record<RenderLogEntry["stage"], string> = {
  compile: "compile",
  render: "render",
  runtime: "runtime",
  watchdog: "watchdog",
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

interface RenderLogPanelProps {
  /** Height of the open drawer in px. */
  height: number;
}

/** Collapsible drawer body listing render-pipeline events newest-at-bottom. Mounted
 *  only when open (the toolbar toggle owns open/closed state). Auto-scrolls to the
 *  newest entry; text is monospace + selectable so a user can copy an error. */
function RenderLogPanel({ height }: RenderLogPanelProps) {
  const entries = useRenderLogStore((s) => s.entries);
  const clear = useRenderLogStore((s) => s.clear);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the view is pinned to the bottom. Stays true while the user sits at the
  // newest entry; flips false the moment they scroll up to read history. Only when
  // pinned do we auto-follow new entries -- otherwise a streaming log (the worker now
  // emits several lines per compile) would yank the user back down mid-read.
  const pinnedRef = useRef(true);

  // Auto-scroll to newest only when pinned to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  // Re-pin when the user scrolls back to (near) the bottom; unpin once they scroll up.
  // 8px slack absorbs sub-pixel rounding so being visually at the bottom counts as pinned.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
  };

  return (
    <div
      style={{
        flex: `0 0 ${height}px`,
        display: "flex",
        flexDirection: "column",
        borderTop: "1px solid #e0e0e0",
        background: "#fafafa",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 8px",
          borderBottom: "1px solid #ececec",
          flex: "0 0 auto",
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontFamily: "sans-serif",
            color: "#888",
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          Render Log
        </span>
        <button
          type="button"
          onClick={clear}
          disabled={entries.length === 0}
          style={{
            background: "#ffffff",
            color: entries.length === 0 ? "#bbb" : "#444",
            border: "1px solid #cfcfcf",
            borderRadius: 4,
            padding: "2px 8px",
            fontSize: 11,
            fontFamily: "sans-serif",
            cursor: entries.length === 0 ? "default" : "pointer",
          }}
        >
          Clear
        </button>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "4px 8px",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 12,
          lineHeight: 1.5,
          // Selectable so a user can copy an error message/stack.
          userSelect: "text",
        }}
      >
        {entries.length === 0 ? (
          <div style={{ color: "#999", fontStyle: "italic" }}>
            No render events yet.
          </div>
        ) : (
          entries.map((e) => (
            <div
              key={e.id}
              style={{ display: "flex", gap: 8, whiteSpace: "pre-wrap" }}
            >
              <span style={{ color: "#aaa", flex: "0 0 auto" }}>
                {formatTime(e.ts)}
              </span>
              <span
                style={{
                  color: LEVEL_COLOR[e.level],
                  flex: "0 0 auto",
                  width: 64,
                }}
              >
                [{STAGE_LABEL[e.stage]}]
              </span>
              <span style={{ color: LEVEL_COLOR[e.level], wordBreak: "break-word" }}>
                {e.message}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default RenderLogPanel;
