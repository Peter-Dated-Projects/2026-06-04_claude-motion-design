import { useEffect, useRef } from "react";
import {
  useRenderLogStore,
  type RenderLogEntry,
  type RenderLogLevel,
} from "../../store/renderLogStore";

// Level -> text color. Errors red, warnings amber, info muted -- consistent with the
// dark preview theme (the red error strip uses the same #ffb4b4 family).
const LEVEL_COLOR: Record<RenderLogLevel, string> = {
  error: "#ff7b7b",
  warn: "#ffd24a",
  info: "#8b94a0",
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

  // Auto-scroll to newest whenever the list grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  return (
    <div
      style={{
        flex: `0 0 ${height}px`,
        display: "flex",
        flexDirection: "column",
        borderTop: "1px solid #2a2a2a",
        background: "#0e0e0e",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 8px",
          borderBottom: "1px solid #1f1f1f",
          flex: "0 0 auto",
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontFamily: "sans-serif",
            color: "#8b94a0",
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
            background: "#1d1d1d",
            color: entries.length === 0 ? "#555" : "#bbb",
            border: "1px solid #333",
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
          <div style={{ color: "#555", fontStyle: "italic" }}>
            No render events yet.
          </div>
        ) : (
          entries.map((e) => (
            <div
              key={e.id}
              style={{ display: "flex", gap: 8, whiteSpace: "pre-wrap" }}
            >
              <span style={{ color: "#555", flex: "0 0 auto" }}>
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
