import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useIGStore } from "../../store/igStore";
import type { StageName } from "../../types/ig";

/**
 * The IG workspace's top-left main-area panel: the flow's entry point.
 *
 * Purely presentational + dispatch. It reads the IG store for
 * phase/source/clip/stageProgress/error and calls `startPhaseA(input)` (a typed
 * URL or a dropped local file path); it NEVER wires Tauri events itself. The
 * store / the integration ticket owns `invoke`/`listen`. The one Tauri import
 * here, `convertFileSrc`, is a pure URL helper (no event wiring) used to point a
 * `<video>` at the clipped local file via the asset protocol (enabled in T-028).
 */

/** Human-readable stage labels for the staged progress bar (Phase A + B). */
const STAGE_LABELS: Record<StageName, string> = {
  download: "Downloading",
  clip: "Clipping",
  frames: "Extracting frames",
  score: "Scoring",
  analyze: "Analyzing",
  store: "Saving",
};

/** Source duration in seconds beyond which the analyze-first-30s notice shows. */
const CLIP_SECONDS = 30;

/** Verbatim notice copy required by the proposal for over-cap sources. */
const OVER_CAP_NOTICE =
  "Analyzing first 30 seconds. Make sure your best moments are up front.";

function VideoPreviewPanel() {
  const phase = useIGStore((s) => s.phase);
  const source = useIGStore((s) => s.source);
  const clip = useIGStore((s) => s.clip);
  const stageProgress = useIGStore((s) => s.stageProgress);
  const error = useIGStore((s) => s.error);
  const startPhaseA = useIGStore((s) => s.startPhaseA);
  const reset = useIGStore((s) => s.reset);

  // Ephemeral UI state only — never mirror anything the store owns.
  const [urlInput, setUrlInput] = useState("");
  const [dropActive, setDropActive] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);

  const submitUrl = () => {
    const url = urlInput.trim();
    if (!url) return;
    startPhaseA({ url });
    setUrlInput("");
  };

  // --- Native OS drag-and-drop of a local video file onto this panel. --------
  //     This window uses Tauri's native drag-drop (the default), so the only way
  //     to get a dropped file's real filesystem path is `onDragDropEvent` — the
  //     HTML5 dataTransfer API never exposes absolute paths in a webview. The
  //     event is window-global, so we hit-test the drop position against THIS
  //     panel's rect and only act when the drop lands over us. Mirrors the
  //     verified pattern in TerminalPanel.
  useEffect(() => {
    // Is a window-physical-pixel point inside this panel? getBoundingClientRect
    // is in CSS pixels, so scale the physical position down by the device ratio.
    const isOverHost = (x: number, y: number): boolean => {
      const host = rootRef.current;
      if (!host) return false;
      const dpr = window.devicePixelRatio || 1;
      const lx = x / dpr;
      const ly = y / dpr;
      const r = host.getBoundingClientRect();
      return lx >= r.left && lx <= r.right && ly >= r.top && ly <= r.bottom;
    };

    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    // Whether the most recent enter/over hovered this panel. We gate the drop on
    // THIS rather than re-hit-testing the drop event's own position: the `drop`
    // payload position is documented as unreliable (notably inaccurate while
    // devtools is attached), whereas the enter/over stream is accurate.
    let overHost = false;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          overHost = isOverHost(p.position.x, p.position.y);
          setDropActive(overHost);
        } else if (p.type === "leave") {
          overHost = false;
          setDropActive(false);
        } else if (p.type === "drop") {
          setDropActive(false);
          const wasOverHost = overHost;
          overHost = false;
          if (!p.paths.length || !wasOverHost) return;
          // Forward the raw first path; the store/backend owns file validation
          // and the local-file-vs-URL branch. We only dispatch.
          startPhaseA({ filePath: p.paths[0] });
        }
      })
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [startPhaseA]);

  const isRunning = phase === "running-A" || phase === "running-B";
  const clipPath = clip?.clipPath ?? null;
  // Probed source duration is authoritative; fall back to the clip's record.
  const durationSeconds =
    source?.durationSeconds ?? clip?.originalDurationSeconds ?? null;
  const sourceUrl = source?.sourceUrl ?? null;

  return (
    <div
      ref={rootRef}
      className="panel panel--ig-preview"
      style={{
        flexDirection: "column",
        height: "100%",
        boxSizing: "border-box",
        padding: 16,
        gap: 12,
        overflow: "auto",
        outline: dropActive ? "2px dashed #6ea8fe" : "none",
        outlineOffset: -2,
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          opacity: 0.7,
        }}
      >
        Video Preview
      </div>

      {/* Done: working clip player replaces the input. Guard against a missing
          clip path — fall through to the running/empty view until ready. */}
      {phase === "done" && clipPath ? (
        <video
          src={convertFileSrc(clipPath)}
          controls
          style={{
            width: "100%",
            maxHeight: "100%",
            background: "#000",
            borderRadius: 6,
            objectFit: "contain",
          }}
        />
      ) : phase === "error" ? (
        // Error: surface the store's message inline, never a blank panel.
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            padding: 16,
            border: "1px solid #5c2a2a",
            background: "#2a1414",
            borderRadius: 6,
            color: "#f6b8b8",
          }}
        >
          <div style={{ fontWeight: 600 }}>Extraction failed</div>
          <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
            {error ?? "Something went wrong, but no error detail was reported."}
          </div>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              alignSelf: "flex-start",
              padding: "6px 14px",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Start over
          </button>
        </div>
      ) : isRunning ? (
        // Running (Phase A, or Phase B re-run streaming here): staged progress.
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            {stageProgress
              ? `${STAGE_LABELS[stageProgress.stage]}...`
              : "Starting..."}
          </div>
          <div
            style={{
              width: "100%",
              height: 8,
              background: "#1c2230",
              borderRadius: 4,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${Math.round(
                  Math.min(1, Math.max(0, stageProgress?.progress ?? 0)) * 100
                )}%`,
                height: "100%",
                background: "#6ea8fe",
                transition: "width 120ms linear",
              }}
            />
          </div>
          {stageProgress?.message ? (
            <div style={{ fontSize: 12, opacity: 0.7 }}>
              {stageProgress.message}
            </div>
          ) : null}
          {sourceUrl ? (
            <div
              style={{
                fontSize: 12,
                opacity: 0.7,
                wordBreak: "break-all",
              }}
            >
              {sourceUrl}
            </div>
          ) : null}
          {durationSeconds != null ? (
            <div style={{ fontSize: 12, opacity: 0.7 }}>
              Detected duration: {durationSeconds.toFixed(1)}s
            </div>
          ) : null}
          {durationSeconds != null && durationSeconds > CLIP_SECONDS ? (
            <div
              style={{
                fontSize: 12,
                lineHeight: 1.5,
                padding: "8px 10px",
                background: "#1c2230",
                borderRadius: 4,
                opacity: 0.9,
              }}
            >
              {OVER_CAP_NOTICE}
            </div>
          ) : null}
        </div>
      ) : (
        // Empty (idle): URL input + native file drop zone.
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitUrl();
                }
              }}
              placeholder="Paste an Instagram reel URL..."
              style={{
                flex: 1,
                padding: "8px 10px",
                fontSize: 13,
                borderRadius: 4,
                border: "1px solid #2a3243",
                background: "#0f131b",
                color: "inherit",
              }}
            />
            <button
              type="button"
              onClick={submitUrl}
              disabled={!urlInput.trim()}
              style={{
                padding: "8px 16px",
                fontSize: 13,
                cursor: urlInput.trim() ? "pointer" : "default",
                opacity: urlInput.trim() ? 1 : 0.5,
              }}
            >
              Download
            </button>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: 120,
              padding: 16,
              textAlign: "center",
              fontSize: 13,
              lineHeight: 1.5,
              borderRadius: 6,
              border: `2px dashed ${dropActive ? "#6ea8fe" : "#2a3243"}`,
              background: dropActive ? "#141d2e" : "#0f131b",
              opacity: dropActive ? 1 : 0.8,
              transition: "background 120ms, border-color 120ms",
            }}
          >
            Drop a local video file here, or paste a URL above to start.
          </div>
        </div>
      )}
    </div>
  );
}

export default VideoPreviewPanel;
