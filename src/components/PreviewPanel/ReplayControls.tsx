import { useCallback, useEffect, useRef, useState } from "react";

// Playback controls rendered below the phone bezel. This component is self-contained:
// the sandbox iframe (src/assets/sandbox-frame.html, from T-026) already handles the
// play/pause/seek/setSpeed/setLoop commands and streams `frameUpdate` events, so all
// replay STATE lives here. It drives the sandbox by posting messages through `iframeRef`
// and stays in sync by listening for the iframe's own messages. The integration pass
// (T-032) only has to mount <ReplayControls iframeRef={...} containerRef={...} /> beneath
// the bezel -- no extra wiring in PreviewPanel.

const DEFAULT_FPS = 30;
const DEFAULT_TOTAL_FRAMES = 150;

const SPEED_OPTIONS = [0.5, 1, 2] as const;
export type PlaybackSpeed = (typeof SPEED_OPTIONS)[number];

// Messages we send TO the sandbox iframe. Mirrors the handlers in sandbox-frame.html.
type ControlMessage =
  | { type: "play" }
  | { type: "pause" }
  | { type: "seek"; frame: number }
  | { type: "setSpeed"; speed: PlaybackSpeed }
  | { type: "setLoop"; loop: boolean };

// Messages we receive FROM the sandbox iframe that this component cares about.
type SandboxMessage =
  | { type: "frameUpdate"; frame: number; totalFrames: number; isPlaying: boolean }
  | { type: "renderOk" };

export interface ReplayControlsProps {
  /** Ref to the sandbox iframe; used both to post commands and to verify message origin. */
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  /**
   * Optional ref to the preview container. When provided, the Space play/pause shortcut
   * only fires while focus is within it ("when PreviewPanel is focused"). When omitted,
   * Space works globally except inside editable elements.
   */
  containerRef?: React.RefObject<HTMLElement | null>;
  fps?: number;
  /** Frame count before the first `frameUpdate` arrives. */
  defaultTotalFrames?: number;
}

/**
 * Format a frame index as `m:ss.ff`, where `ff` is the remaining frame count within the
 * current second (e.g. frame 65 at 30fps -> "0:02.05"). Exported for reuse/testing.
 */
export function formatTime(frame: number, fps: number): string {
  const safeFps = fps > 0 ? fps : DEFAULT_FPS;
  const clamped = Math.max(0, Math.floor(frame));
  const totalSeconds = Math.floor(clamped / safeFps);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const frames = clamped % safeFps;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(frames).padStart(2, "0")}`;
}

// --- Styles (match the PreviewPanel toolbar palette) --------------------------------
const BAR_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 8px",
  borderTop: "1px solid #2a2a2a",
  background: "#161616",
  flex: "0 0 auto",
  fontFamily: "sans-serif",
  fontSize: 12,
  color: "#ddd",
};

const BTN_STYLE: React.CSSProperties = {
  background: "#1d1d1d",
  color: "#ddd",
  border: "1px solid #333",
  borderRadius: 4,
  padding: "3px 8px",
  fontSize: 12,
  lineHeight: 1,
  cursor: "pointer",
  fontFamily: "sans-serif",
  minWidth: 28,
};

const TIME_STYLE: React.CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  fontSize: 12,
  color: "#9aa",
  whiteSpace: "nowrap",
};

function speedButtonStyle(active: boolean): React.CSSProperties {
  return {
    ...BTN_STYLE,
    minWidth: 0,
    color: active ? "#ffd24a" : "#9aa",
    borderColor: active ? "#5a4a16" : "#333",
    background: active ? "#2a2410" : "#1d1d1d",
  };
}

function toggleButtonStyle(active: boolean): React.CSSProperties {
  return {
    ...BTN_STYLE,
    minWidth: 0,
    color: active ? "#ffd24a" : "#9aa",
    borderColor: active ? "#5a4a16" : "#333",
    background: active ? "#2a2410" : "#1d1d1d",
  };
}

// True when keyboard focus sits in a text-entry context (so Space should type, not toggle).
function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
}

function ReplayControls({
  iframeRef,
  containerRef,
  fps = DEFAULT_FPS,
  defaultTotalFrames = DEFAULT_TOTAL_FRAMES,
}: ReplayControlsProps) {
  const [currentFrame, setCurrentFrame] = useState(0);
  const [totalFrames, setTotalFrames] = useState(defaultTotalFrames);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  const [loop, setLoop] = useState(false);

  // While the user is actively dragging the scrubber, ignore inbound frameUpdate frames
  // so the thumb doesn't fight the user's pointer.
  const scrubbingRef = useRef(false);

  const lastFrame = Math.max(0, totalFrames - 1);

  const post = useCallback(
    (msg: ControlMessage) => {
      iframeRef.current?.contentWindow?.postMessage(msg, "*");
    },
    [iframeRef],
  );

  const seekTo = useCallback(
    (frame: number) => {
      const clamped = Math.min(Math.max(0, frame), lastFrame);
      setCurrentFrame(clamped);
      post({ type: "seek", frame: clamped });
    },
    [post, lastFrame],
  );

  // --- Listen to the sandbox iframe -------------------------------------------------
  useEffect(() => {
    const onMessage = (ev: MessageEvent<SandboxMessage>) => {
      // Only trust messages from our own sandbox iframe's window.
      if (ev.source !== iframeRef.current?.contentWindow) return;
      const data = ev.data;
      if (!data || typeof data.type !== "string") return;

      if (data.type === "frameUpdate") {
        if (typeof data.totalFrames === "number" && data.totalFrames > 0) {
          setTotalFrames(data.totalFrames);
        }
        setIsPlaying(!!data.isPlaying);
        if (!scrubbingRef.current && typeof data.frame === "number") {
          setCurrentFrame(data.frame);
        }
      } else if (data.type === "renderOk") {
        // Auto-play whenever a freshly compiled animation renders successfully.
        post({ type: "play" });
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [iframeRef, post]);

  // --- Space = play/pause when the preview is focused -------------------------------
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.code !== "Space" && ev.key !== " ") return;
      if (isEditableTarget(ev.target)) return;
      // Scope to the preview container when one is provided.
      const container = containerRef?.current;
      if (container) {
        const active = document.activeElement;
        if (!(active instanceof Node) || !container.contains(active)) return;
      }
      ev.preventDefault();
      post(isPlaying ? { type: "pause" } : { type: "play" });
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [containerRef, post, isPlaying]);

  const handlePlayPause = () => {
    post(isPlaying ? { type: "pause" } : { type: "play" });
  };

  const handleSpeed = (next: PlaybackSpeed) => {
    setSpeed(next);
    post({ type: "setSpeed", speed: next });
  };

  const handleLoop = () => {
    const next = !loop;
    setLoop(next);
    post({ type: "setLoop", loop: next });
  };

  return (
    <div style={BAR_STYLE}>
      <button
        type="button"
        style={BTN_STYLE}
        onClick={() => seekTo(0)}
        title="Jump to start"
        aria-label="Jump to start"
      >
        |&lt;
      </button>
      <button
        type="button"
        style={BTN_STYLE}
        onClick={() => seekTo(currentFrame - 1)}
        title="Step back one frame"
        aria-label="Step back one frame"
      >
        &lt;
      </button>
      <button
        type="button"
        style={BTN_STYLE}
        onClick={handlePlayPause}
        title={isPlaying ? "Pause" : "Play"}
        aria-label={isPlaying ? "Pause" : "Play"}
        aria-pressed={isPlaying}
      >
        {isPlaying ? "||" : ">"}
      </button>
      <button
        type="button"
        style={BTN_STYLE}
        onClick={() => seekTo(currentFrame + 1)}
        title="Step forward one frame"
        aria-label="Step forward one frame"
      >
        &gt;
      </button>
      <button
        type="button"
        style={BTN_STYLE}
        onClick={() => seekTo(lastFrame)}
        title="Jump to end"
        aria-label="Jump to end"
      >
        &gt;|
      </button>

      <input
        type="range"
        min={0}
        max={lastFrame}
        step={1}
        value={Math.min(currentFrame, lastFrame)}
        aria-label="Scrubber"
        style={{ flex: 1, minWidth: 60, accentColor: "#ffd24a" }}
        onPointerDown={() => {
          scrubbingRef.current = true;
        }}
        onPointerUp={() => {
          scrubbingRef.current = false;
        }}
        onChange={(e) => seekTo(Number(e.target.value))}
      />

      <span style={TIME_STYLE}>
        {formatTime(currentFrame, fps)} / {formatTime(lastFrame, fps)}
      </span>

      <div style={{ display: "inline-flex", gap: 2 }}>
        {SPEED_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            style={speedButtonStyle(speed === option)}
            aria-pressed={speed === option}
            onClick={() => handleSpeed(option)}
            title={`${option}x speed`}
          >
            {option}x
          </button>
        ))}
      </div>

      <button
        type="button"
        style={toggleButtonStyle(loop)}
        aria-pressed={loop}
        onClick={handleLoop}
        title="Toggle loop"
      >
        Loop
      </button>
    </div>
  );
}

export default ReplayControls;
