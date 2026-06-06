import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { useRotoStore, MAX_CLIP_SECONDS } from "../../store/rotoStore";
import { useProjectStore } from "../../store/projectStore";
import type { RotoscopeResult } from "../../types/roto";
import type { LoadedSequence } from "../../store/rotoStore";
import PointOverlay from "./PointOverlay";
import RotoControls from "./RotoControls";
import ReviewModal from "./ReviewModal";
import ProcessingView from "./ProcessingView";

/**
 * The rotoscoping stage's left "Video" pane -- the full interaction surface.
 *
 * Composition (the shell, store, types, and backend commands already exist from
 * T-001..T-003; this is the interactive flesh, T-004):
 *   - empty state until a video is loaded (via the assets pane, T-005)
 *   - a scrubbing <video> player + "Set Start Frame" to lock the reference frame
 *   - PointOverlay for placing fg/bg SAM2 prompt points on the locked frame
 *   - RotoControls for the frame-skip selector + live output-frame estimate
 *   - ReviewModal on Generate (read-only summary), then the rotoscope_video job
 *   - ProcessingView while the job runs, with Cancel
 *
 * Boundary note: the rotoStore is intentionally Tauri-free, and App.tsx wires the
 * `roto://progress` listener app-level but defers the job-START commands
 * (`rotoscope_video` / `cancel_rotoscope`) to this panel. So this is the one place
 * those two invokes live; the store reducers stay pure and we feed results back
 * through the documented actions (startJob / jobComplete / setError).
 */

/** Mirrors App.tsx's ROTO_HOST_KEY -- the LAN host of the optional microservice. */
const ROTO_HOST_KEY = "claude-motion:rotoHost";

/** Source fps assumed for frame<->time conversion when the video is unprobed. */
const ASSUMED_FPS = 30;

/**
 * Looping stop-motion playback of a loaded output's PNG sequence. Advances a
 * frame index on a timer at the sequence's effective fps and loops. Renders the
 * current frame as an <img> over a checkerboard so the transparent rotoscope
 * cut-out reads against the background; all urls are mounted hidden once so the
 * browser caches them and the loop does not flicker on first pass.
 */
function SequencePlayer({
  sequence,
  onClose,
}: {
  sequence: LoadedSequence;
  onClose: () => void;
}) {
  const [frame, setFrame] = useState(0);
  const { urls, fps, name } = sequence;
  const count = urls.length;

  useEffect(() => {
    setFrame(0);
    if (count <= 1) return;
    const periodMs = 1000 / Math.max(1, fps);
    const id = window.setInterval(() => {
      setFrame((f) => (f + 1) % count);
    }, periodMs);
    return () => window.clearInterval(id);
  }, [count, fps]);

  const current = urls[Math.min(frame, count - 1)];

  return (
    <div className="roto-video__seq">
      <div className="roto-video__seq-bar">
        <span className="roto-video__seq-name">{name}</span>
        <span className="roto-video__seq-info">
          {count} {count === 1 ? "frame" : "frames"} @ {fps.toFixed(1)} fps
        </span>
        <button
          type="button"
          className="roto-video__seq-close"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <div className="roto-video__seq-stage">
        {current ? (
          <img className="roto-video__seq-img" src={current} alt={name} draggable={false} />
        ) : (
          <div className="roto-video__empty">This output has no frames.</div>
        )}
        {/* Preload the rest so the loop is flicker-free after the first pass. */}
        <div className="roto-video__seq-preload" aria-hidden>
          {urls.map((u) => (
            <img key={u} src={u} alt="" />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Format seconds as `MM:SS.s` (e.g. 64.2 -> "01:04.2"). */
function formatTimecode(seconds: number): string {
  const safe = Math.max(0, seconds);
  const mins = Math.floor(safe / 60);
  const secs = safe - mins * 60;
  return `${String(mins).padStart(2, "0")}:${secs.toFixed(1).padStart(4, "0")}`;
}

/**
 * Parse a clip-time string. Accepts `MM:SS.f` (e.g. "01:04.5"), or a bare number
 * of seconds (e.g. "64.5"). Returns null for empty / unparseable input so the
 * caller can clear the bound.
 */
function parseTimecode(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.includes(":")) {
    const parts = s.split(":");
    if (parts.length !== 2) return null;
    const m = Number(parts[0]);
    const sec = Number(parts[1]);
    if (!Number.isFinite(m) || !Number.isFinite(sec) || sec < 0) return null;
    return m * 60 + sec;
  }
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Clip-range selector under the scrubber: a track showing the selected
 * [clipStart, clipEnd] region (and the playhead), two editable time inputs, and
 * Set Start / Set End buttons that stamp the current scrub position. Bounds are
 * source-relative seconds; the parent enforces the 60s cap and disables Generate.
 */
function ClipRangeControl({
  duration,
  currentTime,
  clipStart,
  clipEnd,
  onSetStart,
  onSetEnd,
  onSeek,
}: {
  duration: number | null;
  currentTime: number;
  clipStart: number | null;
  clipEnd: number | null;
  onSetStart: (s: number | null) => void;
  onSetEnd: (s: number | null) => void;
  onSeek: (t: number) => void;
}) {
  // Local edit buffers so typing doesn't fight the store; commit on blur/Enter.
  const [startText, setStartText] = useState("");
  const [endText, setEndText] = useState("");

  // Reflect external bound changes (Set buttons, reset) into the inputs.
  useEffect(() => {
    setStartText(clipStart != null ? formatTimecode(clipStart) : "");
  }, [clipStart]);
  useEffect(() => {
    setEndText(clipEnd != null ? formatTimecode(clipEnd) : "");
  }, [clipEnd]);

  const pct = (t: number) =>
    duration && duration > 0 ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0;

  const regionLeft = clipStart != null ? pct(clipStart) : 0;
  const regionRight = clipEnd != null ? pct(clipEnd) : 100;
  const hasRegion = clipStart != null && clipEnd != null && clipEnd > clipStart;

  const seekFromPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!duration || duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    onSeek(frac * duration);
  };

  return (
    <div className="roto-clip">
      <div className="roto-clip__head">
        <span className="roto-clip__label">Clip range</span>
        <button
          type="button"
          className="roto-clip__clear"
          disabled={clipStart == null && clipEnd == null}
          onClick={() => {
            onSetStart(null);
            onSetEnd(null);
          }}
        >
          Clear
        </button>
      </div>

      <div
        className="roto-clip__track"
        onPointerDown={seekFromPointer}
        title={duration ? "Click to seek" : undefined}
      >
        {hasRegion ? (
          <div
            className="roto-clip__region"
            style={{ left: `${regionLeft}%`, width: `${regionRight - regionLeft}%` }}
          />
        ) : null}
        <div className="roto-clip__playhead" style={{ left: `${pct(currentTime)}%` }} />
      </div>

      <div className="roto-clip__inputs">
        <button
          type="button"
          className="roto-clip__set"
          onClick={() => onSetStart(currentTime)}
        >
          Set Start
        </button>
        <input
          className="roto-clip__time"
          value={startText}
          placeholder="--:--"
          aria-label="Clip start time"
          onChange={(e) => setStartText(e.target.value)}
          onBlur={() => onSetStart(parseTimecode(startText))}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        <span className="roto-clip__dash">-</span>
        <input
          className="roto-clip__time"
          value={endText}
          placeholder="--:--"
          aria-label="Clip end time"
          onChange={(e) => setEndText(e.target.value)}
          onBlur={() => onSetEnd(parseTimecode(endText))}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        <button
          type="button"
          className="roto-clip__set"
          onClick={() => onSetEnd(currentTime)}
        >
          Set End
        </button>
      </div>
    </div>
  );
}

export default function RotoVideoPanel() {
  const video = useRotoStore((s) => s.video);
  const loadedSequence = useRotoStore((s) => s.loadedSequence);
  const clearSequence = useRotoStore((s) => s.clearSequence);
  const startFrame = useRotoStore((s) => s.startFrame);
  const clipStart = useRotoStore((s) => s.clipStart);
  const clipEnd = useRotoStore((s) => s.clipEnd);
  const points = useRotoStore((s) => s.points);
  const frameSkip = useRotoStore((s) => s.frameSkip);
  const phase = useRotoStore((s) => s.phase);
  const error = useRotoStore((s) => s.error);
  const setStartFrame = useRotoStore((s) => s.setStartFrame);
  const setClipStart = useRotoStore((s) => s.setClipStart);
  const setClipEnd = useRotoStore((s) => s.setClipEnd);
  const startJob = useRotoStore((s) => s.startJob);
  const jobComplete = useRotoStore((s) => s.jobComplete);
  const setError = useRotoStore((s) => s.setError);

  const slug = useProjectStore((s) => s.activeProject?.slug ?? null);

  const playerRef = useRef<HTMLVideoElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [showModal, setShowModal] = useState(false);

  const fps = video?.fps ?? ASSUMED_FPS;
  const isJobRunning = phase === "uploading" || phase === "processing";
  const fgCount = points.filter((p) => p.label === 1).length;

  // Clip range is "set" only when both bounds form a positive span; otherwise the
  // whole source is uploaded.
  const hasClip = clipStart != null && clipEnd != null && clipEnd > clipStart;
  const duration = video?.durationSeconds ?? null;
  // The portion that will actually be uploaded: the clip span when set, else the
  // full (probed) duration. null when neither is known.
  const effectiveDuration = hasClip
    ? (clipEnd as number) - (clipStart as number)
    : duration;
  // Mirror the service's 60s reject so we don't fire off a doomed upload.
  const exceedsCap =
    effectiveDuration != null && effectiveDuration > MAX_CLIP_SECONDS;

  const canGenerate =
    startFrame != null && fgCount > 0 && !isJobRunning && !!slug && !exceedsCap;

  const videoUrl = video ? convertFileSrc(video.path) : null;

  // --- Setup actions ---------------------------------------------------------

  const lockStartFrame = () => {
    const t = playerRef.current?.currentTime ?? currentTime;
    setStartFrame(Math.max(0, Math.round(t * fps)));
  };

  // --- Job lifecycle ---------------------------------------------------------

  const runJob = async (compress: boolean, quality: number) => {
    setShowModal(false);
    if (!video || startFrame == null || !slug) return;
    const host = localStorage.getItem(ROTO_HOST_KEY) || "localhost";
    // One client-supplied job id, threaded all the way through: the bar shows
    // activity immediately, the backend registers the job under it, and cancel
    // (DELETE /rotoscope/{jobId}) targets this exact id so it reaches the real job.
    const jobId = `roto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    startJob(jobId);
    try {
      // When a clip range is set, trim the source to [clipStart, clipEnd] first
      // and upload that. The downstream rotoscope_video re-clips frame-accurately
      // from `startFrame` with gte(n, start_frame) on whatever file it receives,
      // so the reference frame index must be rebased onto the trimmed clip (the
      // trim drops the first clipStart seconds). Points are spatial coords on the
      // reference frame and are unaffected.
      let sourcePath = video.path;
      let effectiveStartFrame = startFrame;
      if (hasClip) {
        sourcePath = await invoke<string>("trim_video", {
          path: video.path,
          startSecs: clipStart,
          endSecs: clipEnd,
        });
        effectiveStartFrame = Math.max(
          0,
          startFrame - Math.round((clipStart as number) * fps),
        );
      }
      const result = await invoke<RotoscopeResult>("rotoscope_video", {
        slug,
        host,
        sourcePath,
        jobId,
        startFrame: effectiveStartFrame,
        points,
        frameSkip,
        compress,
        quality,
      });
      jobComplete(result);
    } catch (err) {
      setError(typeof err === "string" ? err : `Rotoscope failed: ${String(err)}`);
    }
  };

  const cancelJob = async () => {
    const host = localStorage.getItem(ROTO_HOST_KEY) || "localhost";
    const jobId = useRotoStore.getState().jobId;
    try {
      if (jobId) await invoke("cancel_rotoscope", { host, jobId });
    } catch {
      // The job may already be gone; cancel is best-effort. Either way we return
      // the user to point placement below.
    }
    // Return to the point-placement view, preserving the loaded video / start
    // frame / points. The store exposes no cancel reducer (its `reset` wipes the
    // whole setup), so flip just the job fields back to idle directly.
    useRotoStore.setState({
      phase: "idle",
      jobId: null,
      progress: null,
      error: null,
    });
  };

  // --- Render ----------------------------------------------------------------

  return (
    <div className="roto-video">
      <style>{STYLES}</style>
      <div className="roto-video__label">Video</div>

      {loadedSequence ? (
        // A completed output's PNG sequence is loaded: play it as looping
        // stop-motion. Takes priority over the source-video setup flow; Close
        // returns to whatever source-video state is underneath.
        <SequencePlayer sequence={loadedSequence} onClose={clearSequence} />
      ) : !video ? (
        <div className="roto-video__empty">
          Load a video from the panel on the right, or double-click an output to
          play it.
        </div>
      ) : isJobRunning ? (
        <ProcessingView onCancel={cancelJob} />
      ) : (
        <div className="roto-video__setup">
          {phase === "error" && error ? (
            <div className="roto-video__error">{error}</div>
          ) : null}
          {phase === "done" ? (
            <div className="roto-video__done">
              Rotoscope complete -- see the Outputs pane. Place new points to run
              again.
            </div>
          ) : null}

          {startFrame == null ? (
            // Scrubbing view: pick + lock the reference frame.
            <div className="roto-video__player">
              {videoUrl ? (
                <video
                  ref={playerRef}
                  className="roto-video__el"
                  src={videoUrl}
                  controls
                  playsInline
                  onTimeUpdate={(e) =>
                    setCurrentTime(e.currentTarget.currentTime)
                  }
                />
              ) : null}
              <div className="roto-video__scrub-row">
                <span className="roto-video__frame-readout">
                  frame {Math.max(0, Math.round(currentTime * fps))}
                  {video.fps == null ? " (est. @ 30fps)" : null}
                </span>
                <button
                  type="button"
                  className="roto-video__set-start"
                  onClick={lockStartFrame}
                >
                  Set Start Frame
                </button>
              </div>

              <ClipRangeControl
                duration={duration}
                currentTime={currentTime}
                clipStart={clipStart}
                clipEnd={clipEnd}
                onSetStart={setClipStart}
                onSetEnd={setClipEnd}
                onSeek={(t) => {
                  if (playerRef.current) {
                    playerRef.current.currentTime = t;
                    setCurrentTime(t);
                  }
                }}
              />
            </div>
          ) : (
            // Locked: point placement on the reference frame + change-frame escape.
            <>
              <div className="roto-video__locked-bar">
                <span>Reference frame: {startFrame}</span>
                <button
                  type="button"
                  className="roto-video__change-start"
                  onClick={() => setStartFrame(null)}
                >
                  Change frame
                </button>
              </div>
              {videoUrl ? (
                <PointOverlay
                  videoSrc={videoUrl}
                  referenceTimeSeconds={startFrame / fps}
                />
              ) : null}
            </>
          )}

          {exceedsCap ? (
            <div className="roto-video__cap-warn">
              {hasClip
                ? `Clip is ${effectiveDuration!.toFixed(1)}s -- the service caps uploads at ${MAX_CLIP_SECONDS}s. Trim the range below ${MAX_CLIP_SECONDS}s to generate.`
                : `This video is ${effectiveDuration!.toFixed(0)}s -- the service caps uploads at ${MAX_CLIP_SECONDS}s. Set a clip range under ${MAX_CLIP_SECONDS}s to generate.`}
            </div>
          ) : null}

          <RotoControls
            canGenerate={canGenerate}
            onGenerate={() => setShowModal(true)}
          />
        </div>
      )}

      {showModal ? (
        <ReviewModal
          onConfirm={(compress, quality) => void runJob(compress, quality)}
          onCancel={() => setShowModal(false)}
        />
      ) : null}
    </div>
  );
}

const STYLES = `
.roto-video {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--surface-alt);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.roto-video__label {
  position: sticky;
  top: 0;
  padding: 6px 10px;
  color: var(--text-muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  border-bottom: 1px solid var(--border-soft);
  background: var(--surface-alt);
  z-index: 1;
}
.roto-video__empty {
  padding: 16px 12px;
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.6;
  text-align: center;
}
.roto-video__setup {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: auto;
}
.roto-video__error {
  margin: 8px 12px 0;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  color: #f6b8b8;
  background: #2a1414;
  border: 1px solid #5c2a2a;
  border-radius: 5px;
  white-space: pre-wrap;
}
.roto-video__done {
  margin: 8px 12px 0;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  color: #bfe9c9;
  background: #142a1a;
  border: 1px solid #2a5c38;
  border-radius: 5px;
}
.roto-video__player {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 12px;
}
.roto-video__el {
  display: block;
  width: 100%;
  max-height: 60vh;
  background: #000;
  border-radius: 6px;
  object-fit: contain;
}
.roto-video__scrub-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.roto-video__frame-readout {
  font-size: 11px;
  color: var(--text-faint);
}
.roto-video__set-start {
  padding: 5px 14px;
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  color: #fff;
  background: var(--accent, #6ea8fe);
  border: none;
  border-radius: 5px;
  cursor: pointer;
}
.roto-video__cap-warn {
  margin: 8px 12px 0;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  color: #f4d58d;
  background: #2a2412;
  border: 1px solid #5c4f2a;
  border-radius: 5px;
}
.roto-clip {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 4px;
}
.roto-clip__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.roto-clip__label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
}
.roto-clip__clear {
  padding: 2px 8px;
  font-size: 10px;
  font-family: inherit;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  cursor: pointer;
}
.roto-clip__clear:disabled {
  opacity: 0.4;
  cursor: default;
}
.roto-clip__track {
  position: relative;
  height: 10px;
  border-radius: 5px;
  background: var(--surface);
  border: 1px solid var(--border-soft);
  cursor: pointer;
  overflow: hidden;
}
.roto-clip__region {
  position: absolute;
  top: 0;
  bottom: 0;
  background: var(--accent, #6ea8fe);
  opacity: 0.45;
}
.roto-clip__playhead {
  position: absolute;
  top: -1px;
  bottom: -1px;
  width: 2px;
  margin-left: -1px;
  background: #fff;
}
.roto-clip__inputs {
  display: flex;
  align-items: center;
  gap: 6px;
}
.roto-clip__time {
  width: 64px;
  padding: 3px 6px;
  font-size: 11px;
  font-family: inherit;
  text-align: center;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: 4px;
}
.roto-clip__dash {
  color: var(--text-faint);
}
.roto-clip__set {
  padding: 3px 10px;
  font-size: 11px;
  font-family: inherit;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  cursor: pointer;
}
.roto-video__locked-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px 0;
  font-size: 11px;
  color: var(--text-muted);
}
.roto-video__change-start {
  padding: 3px 10px;
  font-size: 11px;
  font-family: inherit;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  cursor: pointer;
}
.roto-video__seq {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 auto;
}
.roto-video__seq-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  font-size: 11px;
  color: var(--text-muted);
}
.roto-video__seq-name {
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.roto-video__seq-info {
  flex: 1 1 auto;
  color: var(--text-faint);
}
.roto-video__seq-close {
  flex: none;
  padding: 3px 10px;
  font-size: 11px;
  font-family: inherit;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  cursor: pointer;
}
.roto-video__seq-stage {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 12px 12px;
  border-radius: 6px;
  /* Checkerboard so transparent cut-outs read against the background. */
  background-color: #1a1d24;
  background-image:
    linear-gradient(45deg, #2a2e38 25%, transparent 25%),
    linear-gradient(-45deg, #2a2e38 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #2a2e38 75%),
    linear-gradient(-45deg, transparent 75%, #2a2e38 75%);
  background-size: 20px 20px;
  background-position: 0 0, 0 10px, 10px -10px, -10px 0;
}
.roto-video__seq-img {
  display: block;
  max-width: 100%;
  max-height: 60vh;
  object-fit: contain;
}
.roto-video__seq-preload {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
}
`;
