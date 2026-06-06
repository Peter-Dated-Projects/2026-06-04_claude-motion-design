import { useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { useRotoStore } from "../../store/rotoStore";
import { useProjectStore } from "../../store/projectStore";
import type { RotoscopeResult } from "../../types/roto";
import PointOverlay from "./PointOverlay";
import RotoControls from "./RotoControls";
import CompressionModal from "./CompressionModal";
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
 *   - CompressionModal on Generate, then the rotoscope_video job
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

export default function RotoVideoPanel() {
  const video = useRotoStore((s) => s.video);
  const startFrame = useRotoStore((s) => s.startFrame);
  const points = useRotoStore((s) => s.points);
  const frameSkip = useRotoStore((s) => s.frameSkip);
  const phase = useRotoStore((s) => s.phase);
  const error = useRotoStore((s) => s.error);
  const setStartFrame = useRotoStore((s) => s.setStartFrame);
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
  const canGenerate = startFrame != null && fgCount > 0 && !isJobRunning && !!slug;

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
    // Provisional client id; the bar shows activity immediately. The backend owns
    // the real job id for cancel -- which it routes via `host`, not this id.
    startJob(`local-${Date.now()}`);
    try {
      const result = await invoke<RotoscopeResult>("rotoscope_video", {
        slug,
        host,
        sourcePath: video.path,
        startFrame,
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

      {!video ? (
        <div className="roto-video__empty">
          Double-click a video from the panel on the right.
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

          <RotoControls
            canGenerate={canGenerate}
            onGenerate={() => setShowModal(true)}
          />
        </div>
      )}

      {showModal ? (
        <CompressionModal
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
`;
