import { useCallback, useEffect, useRef, useState } from "react";
import "./ReplayControls.css";

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

// --- Inline SVG transport icons ---------------------------------------------------
// Crisp vector icons drawn with currentColor (no icon-font / emoji dependency), following
// the EyeIcon pattern in PreviewPanel. viewBox 0 0 24 24; the bar sets the color.
function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      focusable={false}
    >
      {children}
    </svg>
  );
}

function SkipToStartIcon() {
  return (
    <Icon>
      <rect x={5} y={5} width={2.5} height={14} rx={0.5} />
      <path d="M20 5.5v13a1 1 0 0 1-1.55.84L9 13.2a1 1 0 0 1 0-1.68l9.45-6.14A1 1 0 0 1 20 6.2z" />
    </Icon>
  );
}

function StepBackIcon() {
  return (
    <Icon>
      <path d="M16 5.5v13a1 1 0 0 1-1.55.84L5 13.2a1 1 0 0 1 0-1.68l9.45-6.14A1 1 0 0 1 16 6.2z" />
    </Icon>
  );
}

function PlayIcon() {
  return (
    <Icon>
      <path d="M7 4.5v15a1 1 0 0 0 1.53.85l12-7.5a1 1 0 0 0 0-1.7l-12-7.5A1 1 0 0 0 7 4.5z" />
    </Icon>
  );
}

function PauseIcon() {
  return (
    <Icon>
      <rect x={6} y={5} width={4} height={14} rx={1} />
      <rect x={14} y={5} width={4} height={14} rx={1} />
    </Icon>
  );
}

function StepForwardIcon() {
  return (
    <Icon>
      <path d="M8 5.5v13a1 1 0 0 0 1.55.84L19 13.2a1 1 0 0 0 0-1.68L9.55 5.38A1 1 0 0 0 8 6.2z" />
    </Icon>
  );
}

function SkipToEndIcon() {
  return (
    <Icon>
      <path d="M4 5.5v13a1 1 0 0 0 1.55.84L15 13.2a1 1 0 0 0 0-1.68L5.55 5.38A1 1 0 0 0 4 6.2z" />
      <rect x={16.5} y={5} width={2.5} height={14} rx={0.5} />
    </Icon>
  );
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

  // Autoplay only the FIRST successful render of a session. Subsequent recompiles
  // (Claude/editor edits) must not hijack playback -- we leave the sandbox in whatever
  // play/pause state it was already in, so iterating on code isn't disruptive.
  const hasAutoplayedRef = useRef(false);

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
        // Autoplay only the very first render; later recompiles preserve the prior
        // play/pause state instead of force-restarting playback.
        if (!hasAutoplayedRef.current) {
          hasAutoplayedRef.current = true;
          post({ type: "play" });
        }
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

  const scrubProgress = lastFrame > 0 ? Math.min(currentFrame, lastFrame) / lastFrame : 0;

  return (
    <div className="replay-bar">
      <div className="replay-bar__transport">
        <button
          type="button"
          className="replay-btn"
          onClick={() => seekTo(0)}
          title="Jump to start"
          aria-label="Jump to start"
        >
          <SkipToStartIcon />
        </button>
        <button
          type="button"
          className="replay-btn"
          onClick={() => seekTo(currentFrame - 1)}
          title="Step back one frame"
          aria-label="Step back one frame"
        >
          <StepBackIcon />
        </button>
        <button
          type="button"
          className="replay-btn replay-btn--primary"
          onClick={handlePlayPause}
          title={isPlaying ? "Pause" : "Play"}
          aria-label={isPlaying ? "Pause" : "Play"}
          aria-pressed={isPlaying}
        >
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button
          type="button"
          className="replay-btn"
          onClick={() => seekTo(currentFrame + 1)}
          title="Step forward one frame"
          aria-label="Step forward one frame"
        >
          <StepForwardIcon />
        </button>
        <button
          type="button"
          className="replay-btn"
          onClick={() => seekTo(lastFrame)}
          title="Jump to end"
          aria-label="Jump to end"
        >
          <SkipToEndIcon />
        </button>
      </div>

      <input
        type="range"
        className="replay-scrubber"
        min={0}
        max={lastFrame}
        step={1}
        value={Math.min(currentFrame, lastFrame)}
        aria-label="Scrubber"
        style={{ "--replay-progress": `${scrubProgress * 100}%` } as React.CSSProperties}
        onPointerDown={() => {
          scrubbingRef.current = true;
        }}
        onPointerUp={() => {
          scrubbingRef.current = false;
        }}
        onChange={(e) => seekTo(Number(e.target.value))}
      />

      <span className="replay-time">
        {formatTime(currentFrame, fps)} / {formatTime(lastFrame, fps)}
      </span>

      <div className="replay-speed">
        {SPEED_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            className={`replay-chip${speed === option ? " replay-chip--active" : ""}`}
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
        className={`replay-chip${loop ? " replay-chip--active" : ""}`}
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
