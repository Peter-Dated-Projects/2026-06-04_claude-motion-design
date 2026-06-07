import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useRotoStore, MAX_CLIP_SECONDS } from "../../store/rotoStore";
import { useProjectStore } from "../../store/projectStore";
import { useRotoJobQueueApi } from "../../hooks/useRotoJobQueue";
import type { RotoscopeParams } from "../../types/roto";
import type { LoadedSequence } from "../../store/rotoStore";
import PointOverlay from "./PointOverlay";
import RotoControls from "./RotoControls";
import ReviewModal from "./ReviewModal";
import ProcessingView from "./ProcessingView";
import ComparisonPlayer from "./ComparisonPlayer";

/**
 * The rotoscoping stage's left "Video" pane -- the full interaction surface.
 *
 * Composition (the shell, store, types, and backend commands already exist from
 * T-001..T-003):
 *   - empty state until a video is loaded (via the assets pane)
 *   - PointOverlay anchored to the reference frame (frame 0 of the selected clip)
 *     for placing fg/bg SAM2 prompt points -- always visible at rest, no manual
 *     "Set Start Frame" lock step (see decision roto-reference-frame-is-clip-
 *     frame-zero)
 *   - a custom two-row control bar (ClipRangeControl) replacing native <video>
 *     chrome: row 1 = seekable clip-region track with drag-to-select; row 2 =
 *     speed selector, rewind/play/skip transport, and a time + frame readout
 *   - RotoControls for the frame-skip selector + live output-frame estimate
 *   - ReviewModal on Generate, then the rotoscope_video job via the queue
 *   - ProcessingView while the job runs, with Cancel
 *
 * Reference frame & preview-playback coexistence (resolves the PROJECT.md open
 * question): the SAM2 reference frame is implicitly frame 0 of the clip
 * (`clipStart`, or 0 when no region is set) -- it is derived at enqueue time in
 * useRotoJobQueue, never picked manually here. The point-placement overlay is
 * always anchored there. Transient clip preview (the row-2 transport) coexists
 * with it WITHOUT a hard mode switch via a derived flag:
 *
 *     showOverlay = !playing && atReferenceFrame
 *
 * i.e. while the playhead rests on the reference frame and nothing is playing we
 * show PointOverlay (points on frame 0); playing or scrubbing off frame 0 reveals
 * the live preview <video> and hides the overlay. Rewind (|<) -- and any region
 * re-anchor that moves clipStart -- snaps the playhead back to the reference
 * frame, which restores the overlay with its points intact (points live in the
 * store and are never cleared by playback). One screen, no lock/unlock.
 *
 * Boundary note: the rotoStore is intentionally Tauri-free. The job-START
 * commands live in the `useRotoJobQueue` hook -- Generate enqueues a job and the
 * hook runs it, so the user can stack a second job while the first runs. This
 * panel still shows the single-job ProcessingView / done / error banners for the
 * active job via the rotoStore, which the hook keeps in sync.
 */

/** Source fps assumed for frame<->time conversion when the video is unprobed. */
const ASSUMED_FPS = 30;

const COMPARE_LAYOUT_KEY = "claude-motion:rotoCompareLayout";

/** Selectable preview playback speeds for the row-2 speed control. */
const PLAYBACK_RATES = [0.5, 1, 2];

/** Pointer slop (px) within which a press grabs an existing clip handle. */
const HANDLE_HIT_PX = 12;

/** Half-frame-ish epsilon (s) for "the playhead is on the reference frame". */
const REFERENCE_EPSILON = 0.04;

/**
 * Shared spacebar play/pause: a window-level `keydown` listener that fires
 * `onToggle` on Space, but never while focus is in a text-entry surface (INPUT,
 * TEXTAREA, or any contenteditable -- e.g. Monaco's accessibility layer), so
 * typing a clip time or a filename never toggles playback. No-op while
 * `enabled` is false, so a player that isn't on screen doesn't steal the key
 * (the source scrubber and the SequencePlayer are mounted at different times).
 * `onToggle` is read through a ref so the listener binds once per `enabled`
 * flip rather than on every render.
 */
function useSpacebarToggle(enabled: boolean, onToggle: () => void) {
  const cb = useRef(onToggle);
  cb.current = onToggle;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName ?? "";
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      e.preventDefault();
      cb.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

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
  // S3: playback is user-controlled. Starts playing on load; the interval
  // timer below is conditional on this flag.
  const [playing, setPlaying] = useState(true);
  const [scrubbing, setScrubbing] = useState(false);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const { urls, fps, name } = sequence;
  const count = urls.length;

  // Reset to the first frame and resume playback whenever a new sequence loads.
  useEffect(() => {
    setFrame(0);
    setPlaying(true);
  }, [count, fps]);

  // Advance the loop only while playing (and not mid-scrub). Re-created when
  // playing / count / fps change, mirroring the old unconditional timer.
  useEffect(() => {
    if (!playing || scrubbing || count <= 1) return;
    const periodMs = 1000 / Math.max(1, fps);
    const id = window.setInterval(() => {
      setFrame((f) => (f + 1) % count);
    }, periodMs);
    return () => window.clearInterval(id);
  }, [playing, scrubbing, count, fps]);

  // Spacebar toggles play/pause for the loaded output (same guard as the source
  // scrubber). Only active while there is more than one frame to animate.
  useSpacebarToggle(count > 1, () => setPlaying((p) => !p));

  const frameFromPointer = (clientX: number): number => {
    const track = trackRef.current;
    if (!track || count <= 1) return 0;
    const rect = track.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.min(count - 1, Math.max(0, Math.round(frac * (count - 1))));
  };

  // Dragging the handle sets the frame directly and pauses playback (same
  // interaction model as ClipRangeControl's seek track).
  const onTrackDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setPlaying(false);
    setScrubbing(true);
    setFrame(frameFromPointer(e.clientX));
  };
  const onTrackMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (scrubbing) setFrame(frameFromPointer(e.clientX));
  };
  const onTrackUp = () => setScrubbing(false);

  const current = urls[Math.min(frame, count - 1)];
  const pct = count > 1 ? (frame / (count - 1)) * 100 : 0;

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
      {count > 1 ? (
        <div className="roto-video__seq-controls">
          <button
            type="button"
            className="roto-video__seq-play"
            onClick={() => setPlaying((p) => !p)}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? "Pause" : "Play"}
          </button>
          <div
            ref={trackRef}
            className="roto-video__seq-track"
            onPointerDown={onTrackDown}
            onPointerMove={onTrackMove}
            onPointerUp={onTrackUp}
            onPointerCancel={onTrackUp}
            onLostPointerCapture={onTrackUp}
            title="Drag to scrub"
          >
            <div className="roto-video__seq-fill" style={{ width: `${pct}%` }} />
            <div className="roto-video__seq-handle" style={{ left: `${pct}%` }} />
          </div>
          <span className="roto-video__seq-readout">
            frame {Math.min(frame + 1, count)} / {count} @ {fps.toFixed(1)} fps
          </span>
        </div>
      ) : null}
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

/** Compact fps label: integers bare ("30"), otherwise up to 2 decimals ("29.97"). */
function fpsLabel(fps: number): string {
  return Number.isInteger(fps) ? String(fps) : fps.toFixed(2).replace(/\.?0+$/, "");
}

// --- Inline transport / mode icons (no icon dependency, matches the app) -----

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden focusable="false">
      <path d="M4 3l9 5-9 5z" fill="currentColor" />
    </svg>
  );
}
function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden focusable="false">
      <rect x="4" y="3" width="3" height="10" fill="currentColor" />
      <rect x="9" y="3" width="3" height="10" fill="currentColor" />
    </svg>
  );
}
function RewindIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden focusable="false">
      <rect x="3" y="3" width="2" height="10" fill="currentColor" />
      <path d="M13 3v10l-7-5z" fill="currentColor" />
    </svg>
  );
}
function SkipIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden focusable="false">
      <path d="M3 3l7 5-7 5z" fill="currentColor" />
      <rect x="11" y="3" width="2" height="10" fill="currentColor" />
    </svg>
  );
}
function SelectIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden focusable="false">
      <path
        d="M3 3h3M3 3v3M13 3h-3M13 3v3M3 13h3M3 13v-3M13 13h-3M13 13v-3"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
function ClearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden focusable="false">
      <path
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The custom two-row control bar (replaces native `<video controls>`). Owns only
 * its in-gesture drag bookkeeping; the playhead, clip bounds, and transport are
 * driven by the parent.
 *
 * Row 1 -- a "Select Region" toggle, the seek/region track, and a Clear icon:
 *   - OUT of select mode: a bare press seeks (parent pauses + shows the live
 *     frame). The region span renders dimmed when no region is set (visually
 *     distinct from a clip set to the full length) and at full opacity once a
 *     bound exists, with darkened flanks outside it.
 *   - IN select mode: draggable start/end handles (hit-tested first), and a
 *     bare-track press anchors a NEW range and drags its end out. Pointer
 *     capture keeps the whole gesture on the track so seek + range-edit never
 *     double-fire. Clamped so start <= end.
 *
 * Row 2 -- speed selector, rewind (|< to clip start) / play-pause / skip (>| to
 * clip end), and a time + frame readout (`frame N @ {fps}fps` once probed, else
 * the `~30fps` fallback). No volume / AirPlay / PiP / fullscreen affordances.
 */
function ClipRangeControl({
  duration,
  currentTime,
  clipStart,
  clipEnd,
  fps,
  fpsKnown,
  playing,
  playbackRate,
  selectMode,
  onSeek,
  onSetClipStart,
  onSetClipEnd,
  onToggleSelect,
  onClear,
  onTogglePlay,
  onRewind,
  onSkip,
  onRate,
}: {
  duration: number | null;
  currentTime: number;
  clipStart: number | null;
  clipEnd: number | null;
  fps: number;
  fpsKnown: boolean;
  playing: boolean;
  playbackRate: number;
  selectMode: boolean;
  onSeek: (t: number) => void;
  onSetClipStart: (s: number | null) => void;
  onSetClipEnd: (s: number | null) => void;
  onToggleSelect: () => void;
  onClear: () => void;
  onTogglePlay: () => void;
  onRewind: () => void;
  onSkip: () => void;
  onRate: (r: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  // Which bound the active select-mode pointer gesture is editing, or null.
  const dragRef = useRef<"start" | "end" | null>(null);

  const dur = duration && duration > 0 ? duration : null;
  const pct = (t: number) =>
    dur ? Math.min(100, Math.max(0, (t / dur) * 100)) : 0;

  // A region is "set" once either bound exists; otherwise the track shows a
  // dimmed full-width span (whole clip, unselected) -- visually distinct from a
  // clip explicitly set to its full length.
  const hasRegion = clipStart != null || clipEnd != null;
  const regionLeft = clipStart != null ? pct(clipStart) : 0;
  const regionRight = clipEnd != null ? pct(clipEnd) : 100;
  const hasSpan = regionRight > regionLeft;

  const timeFromPointer = (clientX: number): number | null => {
    const track = trackRef.current;
    if (!track || !dur) return null;
    const rect = track.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return frac * dur;
  };

  const onTrackDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const t = timeFromPointer(e.clientX);
    if (t == null) return;
    if (!selectMode) {
      onSeek(t);
      return;
    }
    // Select mode: capture the gesture and decide handle-drag vs new-range.
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    const xOf = (frac: number) => rect.left + frac * rect.width;
    const dStart =
      clipStart != null ? Math.abs(e.clientX - xOf(regionLeft / 100)) : Infinity;
    const dEnd =
      clipEnd != null ? Math.abs(e.clientX - xOf(regionRight / 100)) : Infinity;
    if (dStart <= HANDLE_HIT_PX && dStart <= dEnd) {
      dragRef.current = "start";
      onSetClipStart(Math.min(t, clipEnd ?? dur ?? t));
    } else if (dEnd <= HANDLE_HIT_PX) {
      dragRef.current = "end";
      onSetClipEnd(Math.max(t, clipStart ?? 0));
    } else {
      // Bare-track press: anchor a fresh range here and drag the end outward.
      dragRef.current = "end";
      onSetClipStart(t);
      onSetClipEnd(t);
    }
  };

  const onTrackMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!selectMode || !dragRef.current) return;
    const t = timeFromPointer(e.clientX);
    if (t == null) return;
    if (dragRef.current === "start") {
      onSetClipStart(Math.min(t, clipEnd ?? dur ?? t));
    } else {
      onSetClipEnd(Math.max(t, clipStart ?? 0));
    }
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  return (
    <div className="roto-bar">
      <div className="roto-bar__row">
        <button
          type="button"
          className={`roto-bar__select${selectMode ? " roto-bar__select--on" : ""}`}
          onClick={onToggleSelect}
          title={
            selectMode
              ? "Done -- drag on the track to (re)define the clip region"
              : "Select a clip region by dragging on the track"
          }
        >
          <SelectIcon />
          <span>Region</span>
        </button>

        <div
          ref={trackRef}
          className={`roto-bar__track${selectMode ? " roto-bar__track--select" : ""}`}
          onPointerDown={onTrackDown}
          onPointerMove={onTrackMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          title={dur ? (selectMode ? "Drag to set the clip region" : "Click to seek") : undefined}
        >
          {hasSpan ? (
            <div
              className={`roto-bar__region${hasRegion ? "" : " roto-bar__region--dim"}`}
              style={{ left: `${regionLeft}%`, width: `${regionRight - regionLeft}%` }}
            />
          ) : null}
          {hasRegion && hasSpan && regionLeft > 0 ? (
            <div className="roto-bar__mask" style={{ left: 0, width: `${regionLeft}%` }} />
          ) : null}
          {hasRegion && hasSpan && regionRight < 100 ? (
            <div
              className="roto-bar__mask"
              style={{ left: `${regionRight}%`, width: `${100 - regionRight}%` }}
            />
          ) : null}
          {selectMode && clipStart != null ? (
            <div className="roto-bar__handle" style={{ left: `${regionLeft}%` }} />
          ) : null}
          {selectMode && clipEnd != null ? (
            <div className="roto-bar__handle" style={{ left: `${regionRight}%` }} />
          ) : null}
          <div className="roto-bar__playhead" style={{ left: `${pct(currentTime)}%` }} />
        </div>

        <button
          type="button"
          className="roto-bar__clear"
          onClick={onClear}
          disabled={!hasRegion}
          title="Clear clip region"
          aria-label="Clear clip region"
        >
          <ClearIcon />
        </button>
      </div>

      <div className="roto-bar__row roto-bar__row--controls">
        <select
          className="roto-bar__speed"
          value={playbackRate}
          onChange={(e) => onRate(Number(e.target.value))}
          title="Playback speed"
          aria-label="Playback speed"
        >
          {PLAYBACK_RATES.map((r) => (
            <option key={r} value={r}>
              {r}x
            </option>
          ))}
        </select>

        <div className="roto-bar__transport">
          <button
            type="button"
            className="roto-bar__btn"
            onClick={onRewind}
            title="Back to clip start"
            aria-label="Back to clip start"
          >
            <RewindIcon />
          </button>
          <button
            type="button"
            className="roto-bar__btn roto-bar__btn--play"
            onClick={onTogglePlay}
            title={playing ? "Pause" : "Play"}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button
            type="button"
            className="roto-bar__btn"
            onClick={onSkip}
            title="Jump to clip end"
            aria-label="Jump to clip end"
          >
            <SkipIcon />
          </button>
        </div>

        <div className="roto-bar__readout">
          <span className="roto-bar__time">
            {formatTimecode(currentTime)}
            {dur ? ` / ${formatTimecode(dur)}` : ""}
          </span>
          <span className="roto-bar__frame">
            frame {Math.max(0, Math.round(currentTime * fps))} @{" "}
            {fpsKnown ? `${fpsLabel(fps)}fps` : "~30fps"}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function RotoVideoPanel() {
  const video = useRotoStore((s) => s.video);
  const loadedSequence = useRotoStore((s) => s.loadedSequence);
  const comparisonNonce = useRotoStore((s) => s.comparisonNonce);
  const clearSequence = useRotoStore((s) => s.clearSequence);
  const clipStart = useRotoStore((s) => s.clipStart);
  const clipEnd = useRotoStore((s) => s.clipEnd);
  const points = useRotoStore((s) => s.points);
  const frameSkip = useRotoStore((s) => s.frameSkip);
  const phase = useRotoStore((s) => s.phase);
  const error = useRotoStore((s) => s.error);
  const setClipStart = useRotoStore((s) => s.setClipStart);
  const setClipEnd = useRotoStore((s) => s.setClipEnd);

  const slug = useProjectStore((s) => s.activeProject?.slug ?? null);
  const queue = useRotoJobQueueApi();

  const playerRef = useRef<HTMLVideoElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [selectMode, setSelectMode] = useState(false);
  // Source duration probed off the preview <video> element. The store's
  // LoadedVideo.durationSeconds is never populated (no probe command exists),
  // so the element's loadedmetadata is the only source that makes the seek track
  // functional. Falls back to null until metadata loads.
  const [probedDuration, setProbedDuration] = useState<number | null>(null);
  const [showModal, setShowModal] = useState(false);

  // Comparison mode state
  const [comparisonActive, setComparisonActive] = useState(false);
  const [compareLayout, setCompareLayout] = useState<"side-by-side" | "stacked">(() => {
    const stored = localStorage.getItem(COMPARE_LAYOUT_KEY);
    return stored === "stacked" ? "stacked" : "side-by-side";
  });

  const fps = video?.fps ?? ASSUMED_FPS;
  const fpsKnown = video?.fps != null;
  const isJobRunning = phase === "uploading" || phase === "processing";
  const fgCount = points.filter((p) => p.label === 1).length;

  // Clip range is "set" only when both bounds form a positive span; otherwise the
  // whole source is uploaded.
  const hasClip = clipStart != null && clipEnd != null && clipEnd > clipStart;
  const duration = video?.durationSeconds ?? probedDuration;
  // The portion that will actually be uploaded: the clip span when set, else the
  // full (probed) duration. null when neither is known.
  const effectiveDuration = hasClip
    ? (clipEnd as number) - (clipStart as number)
    : duration;
  // Mirror the service's 60s reject so we don't fire off a doomed upload.
  const exceedsCap =
    effectiveDuration != null && effectiveDuration > MAX_CLIP_SECONDS;

  // The SAM2 reference frame is implicitly frame 0 of the clip: clipStart, or 0
  // when no region is set. Used to anchor PointOverlay and to home the playhead.
  const referenceTime = clipStart ?? 0;
  const atReference = Math.abs(currentTime - referenceTime) < REFERENCE_EPSILON;
  // Show the point-placement overlay only while resting on the reference frame;
  // playing or scrubbing off it reveals the live preview video (see file header).
  const showOverlay = !playing && atReference;

  // Generation no longer waits for a manual reference-frame lock -- it just needs
  // at least one foreground point, a project, no in-flight job, and a clip within
  // the service cap. The reference frame is derived at enqueue from clipStart.
  const canGenerate = fgCount > 0 && !isJobRunning && !!slug && !exceedsCap;

  const canCompare = video != null && loadedSequence != null;

  // Disable comparison if either side goes away.
  useEffect(() => {
    if (!canCompare) setComparisonActive(false);
  }, [canCompare]);

  // Reset the local playback view whenever a different source video loads.
  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setProbedDuration(null);
    setSelectMode(false);
  }, [video?.path]);

  // Keep the preview element's rate in sync with the speed selector.
  useEffect(() => {
    if (playerRef.current) playerRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  // S5: the Outputs pane's "Compare" button loads a (sequence, source-clip) pair
  // and bumps comparisonNonce to ask us to enter comparison mode automatically.
  // Watch for the nonce changing (not its initial value, so a fresh mount with a
  // stale nonce doesn't auto-open) and flip comparison on.
  const lastComparisonNonce = useRef(comparisonNonce);
  useEffect(() => {
    if (comparisonNonce !== lastComparisonNonce.current) {
      lastComparisonNonce.current = comparisonNonce;
      setComparisonActive(true);
    }
  }, [comparisonNonce]);

  const toggleLayout = () => {
    setCompareLayout((prev) => {
      const next = prev === "side-by-side" ? "stacked" : "side-by-side";
      localStorage.setItem(COMPARE_LAYOUT_KEY, next);
      return next;
    });
  };

  const videoUrl = video ? convertFileSrc(video.path) : null;

  // --- Preview transport -----------------------------------------------------

  const seekElement = (t: number) => {
    const v = playerRef.current;
    if (!v) return;
    try {
      v.currentTime = t;
    } catch {
      /* seeking before metadata is ready throws on some platforms; harmless */
    }
  };

  const clampTime = (t: number) =>
    duration ? Math.min(duration, Math.max(0, t)) : Math.max(0, t);

  // Seek to a time and pause there, showing the live frame (overlay hides unless
  // the target is the reference frame). Used by track-seek, rewind, and skip.
  const seekTo = (t: number) => {
    const ct = clampTime(t);
    setCurrentTime(ct);
    seekElement(ct);
    setPlaying(false);
    playerRef.current?.pause();
  };

  const togglePlay = () => {
    const v = playerRef.current;
    if (!v) return;
    if (playing) {
      v.pause();
      setPlaying(false);
      return;
    }
    // Start playback. Snap into the clip when a region is set (or the playhead
    // sits past its end), so preview always plays the selected span.
    let from = currentTime;
    if (hasClip && (from < (clipStart as number) || from >= (clipEnd as number))) {
      from = clipStart as number;
    }
    seekElement(from);
    setCurrentTime(from);
    setPlaying(true);
    void v.play();
  };

  const rewind = () => seekTo(referenceTime); // home -> overlay snaps back to frame 0
  const skip = () => seekTo(hasClip ? (clipEnd as number) : duration ?? referenceTime);

  const onTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const t = e.currentTarget.currentTime;
    // Keep transient preview inside the selected region.
    if (playing && hasClip && t >= (clipEnd as number)) {
      e.currentTarget.pause();
      setPlaying(false);
      setCurrentTime(clipEnd as number);
      return;
    }
    setCurrentTime(t);
  };

  const onLoadedMeta = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const d = e.currentTarget.duration;
    if (Number.isFinite(d) && d > 0) setProbedDuration(d);
    e.currentTarget.playbackRate = playbackRate;
  };

  // Setting the clip start re-anchors the reference frame; while not previewing,
  // home the playhead onto it so the overlay + readout follow the new frame 0.
  const handleSetClipStart = (s: number | null) => {
    setClipStart(s);
    if (!playing) {
      const ref = s ?? 0;
      setCurrentTime(ref);
      seekElement(ref);
    }
  };

  const handleClear = () => {
    setClipStart(null);
    setClipEnd(null);
    if (!playing) {
      setCurrentTime(0);
      seekElement(0);
    }
  };

  // Spacebar toggles the source preview's play/pause whenever the source-video
  // surface is the thing on screen (no output sequence / comparison, no running
  // job). Same text-entry guard as elsewhere lives in useSpacebarToggle.
  const scrubSpacebarEnabled =
    videoUrl != null &&
    loadedSequence == null &&
    !comparisonActive &&
    !isJobRunning;
  useSpacebarToggle(scrubSpacebarEnabled, togglePlay);

  // --- Job lifecycle ---------------------------------------------------------

  const runJob = (compress: boolean, quality: number) => {
    setShowModal(false);
    if (!video || !slug) return;
    // Hand the job to the queue. Clip bounds are carried RAW -- the trim runs
    // inside the hook at job-start time, not here, so a queued job that is
    // cancelled before it runs never spills a temp file. `fps` rides along so
    // the hook can derive + rebase the reference frame onto the trimmed clip.
    // `startFrame` is legacy/ignored at run time (the hook derives the reference
    // from clipStart); pass the same derived value for a faithful summary.
    const startFrame = Math.round((clipStart ?? 0) * fps);
    const params: RotoscopeParams = {
      slug,
      sourcePath: video.path,
      startFrame,
      clipStart: hasClip ? clipStart : null,
      clipEnd: hasClip ? clipEnd : null,
      points,
      frameSkip,
      compress,
      quality,
      fps,
    };
    const basename = video.path.split(/[/\\]/).pop() || video.path;
    queue.enqueue(params, `${basename}${hasClip ? " (clip)" : ""}`);
  };

  const cancelJob = () => {
    // Delegate the backend teardown to the queue (it owns the cancel_rotoscope
    // invoke and the card state), then return this pane to point placement. The
    // store exposes no cancel reducer (its `reset` wipes the whole setup), so
    // flip just the job fields back to idle directly.
    const jobId = useRotoStore.getState().jobId;
    // queue.cancel may promote the next queued job to running (and call
    // startJob() for it) before returning. Only reset the store back to idle
    // when the queue is now idle -- otherwise we'd clobber the just-promoted
    // job's freshly-written store state.
    const promotedNext = jobId ? queue.cancel(jobId) : false;
    if (!promotedNext) {
      useRotoStore.setState({
        phase: "idle",
        jobId: null,
        progress: null,
        error: null,
      });
    }
  };

  // --- Render ----------------------------------------------------------------

  return (
    <div className="roto-video">
      <style>{STYLES}</style>
      <div className="roto-video__label">
        <span>Video</span>
        <div className="roto-video__compare-toolbar">
          {comparisonActive ? (
            <button
              type="button"
              className="roto-video__layout-btn"
              onClick={toggleLayout}
              title={compareLayout === "side-by-side" ? "Switch to stacked" : "Switch to side-by-side"}
            >
              {compareLayout === "side-by-side" ? "Stack" : "Side"}
            </button>
          ) : null}
          <button
            type="button"
            className={`roto-video__compare-btn${comparisonActive ? " roto-video__compare-btn--active" : ""}`}
            disabled={!canCompare}
            onClick={() => setComparisonActive((v) => !v)}
            title={canCompare ? "Toggle source/output comparison" : "Load a source video and an output sequence to compare"}
          >
            Compare
          </button>
        </div>
      </div>

      {comparisonActive && canCompare && videoUrl ? (
        <ComparisonPlayer
          videoUrl={videoUrl}
          sequence={loadedSequence}
          effectiveDuration={effectiveDuration ?? 0}
          fps={fps}
          frameSkip={frameSkip}
          layout={compareLayout}
        />
      ) : loadedSequence ? (
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

          <div className="roto-video__editor">
            {videoUrl ? (
              <div className="roto-video__stage">
                {/* Point placement on the reference frame (clip frame 0). Always
                    mounted so its seeked frame + placed points survive a preview;
                    hidden (not unmounted) while previewing. */}
                <div className={`roto-video__overlay-host${showOverlay ? "" : " roto-video__hidden"}`}>
                  <PointOverlay videoSrc={videoUrl} referenceTimeSeconds={referenceTime} />
                </div>
                {/* Live preview surface for the transport. Always mounted (it is
                    also the only source of `duration` via loadedmetadata); shown
                    only while playing / scrubbed off the reference frame. */}
                <div className={`roto-video__preview-wrap${showOverlay ? " roto-video__hidden" : ""}`}>
                  <video
                    ref={playerRef}
                    className="roto-video__preview"
                    src={videoUrl}
                    playsInline
                    muted
                    preload="auto"
                    onLoadedMetadata={onLoadedMeta}
                    onTimeUpdate={onTimeUpdate}
                    onEnded={() => setPlaying(false)}
                  />
                </div>
              </div>
            ) : null}

            <ClipRangeControl
              duration={duration}
              currentTime={currentTime}
              clipStart={clipStart}
              clipEnd={clipEnd}
              fps={fps}
              fpsKnown={fpsKnown}
              playing={playing}
              playbackRate={playbackRate}
              selectMode={selectMode}
              onSeek={seekTo}
              onSetClipStart={handleSetClipStart}
              onSetClipEnd={setClipEnd}
              onToggleSelect={() => setSelectMode((v) => !v)}
              onClear={handleClear}
              onTogglePlay={togglePlay}
              onRewind={rewind}
              onSkip={skip}
              onRate={setPlaybackRate}
            />
          </div>

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
          onConfirm={(compress, quality) => runJob(compress, quality)}
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
  display: flex;
  align-items: center;
  justify-content: space-between;
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
.roto-video__editor {
  display: flex;
  flex-direction: column;
}
.roto-video__stage {
  display: block;
}
.roto-video__hidden {
  display: none !important;
}
.roto-video__preview-wrap {
  padding: 8px 12px;
}
.roto-video__preview {
  display: block;
  width: 100%;
  max-height: 60vh;
  background: #000;
  border-radius: 6px;
  object-fit: contain;
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

/* --- Custom two-row control bar ------------------------------------------- */
.roto-bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 12px 8px;
}
.roto-bar__row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.roto-bar__select {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  font-size: 11px;
  font-family: inherit;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  cursor: pointer;
}
.roto-bar__select--on {
  color: var(--accent, #6ea8fe);
  border-color: var(--accent, #6ea8fe);
  background: rgba(110, 168, 254, 0.10);
}
.roto-bar__track {
  position: relative;
  flex: 1 1 auto;
  height: 26px;
  border-radius: 5px;
  background: var(--surface);
  border: 1px solid var(--border-soft);
  cursor: pointer;
  overflow: hidden;
  touch-action: none;
  user-select: none;
}
.roto-bar__track--select {
  cursor: ew-resize;
  border-color: var(--accent, #6ea8fe);
}
.roto-bar__region {
  position: absolute;
  top: 0;
  bottom: 0;
  background: var(--accent, #6ea8fe);
  opacity: 0.85;
  pointer-events: none;
}
.roto-bar__region--dim {
  /* No region set yet: the whole-clip span reads faint, visually distinct from
     a region explicitly set to the full length (full opacity). */
  opacity: 0.18;
}
.roto-bar__mask {
  position: absolute;
  top: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  pointer-events: none;
}
.roto-bar__handle {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 4px;
  margin-left: -2px;
  border-radius: 2px;
  background: #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
  pointer-events: none;
}
.roto-bar__playhead {
  position: absolute;
  top: -1px;
  bottom: -1px;
  width: 2px;
  margin-left: -1px;
  background: #fff;
  pointer-events: none;
}
.roto-bar__clear {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  cursor: pointer;
}
.roto-bar__clear:disabled {
  opacity: 0.35;
  cursor: default;
}
.roto-bar__row--controls {
  gap: 10px;
}
.roto-bar__speed {
  flex: none;
  padding: 3px 6px;
  font-size: 11px;
  font-family: inherit;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  cursor: pointer;
}
.roto-bar__transport {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.roto-bar__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 26px;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  cursor: pointer;
}
.roto-bar__btn--play {
  color: #fff;
  background: var(--accent, #6ea8fe);
  border-color: var(--accent, #6ea8fe);
}
.roto-bar__readout {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-left: auto;
  white-space: nowrap;
}
.roto-bar__time {
  font-size: 11px;
  color: var(--text);
}
.roto-bar__frame {
  font-size: 11px;
  color: var(--text-faint);
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
.roto-video__seq-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px 12px;
  flex: none;
}
.roto-video__seq-play {
  flex: none;
  padding: 3px 10px;
  font-size: 11px;
  font-family: inherit;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  cursor: pointer;
  min-width: 44px;
}
.roto-video__seq-track {
  position: relative;
  flex: 1 1 auto;
  height: 10px;
  border-radius: 5px;
  background: var(--surface);
  border: 1px solid var(--border-soft);
  cursor: pointer;
  overflow: visible;
  touch-action: none;
  user-select: none;
}
.roto-video__seq-fill {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  border-radius: 5px 0 0 5px;
  background: var(--accent, #6ea8fe);
  opacity: 0.55;
  pointer-events: none;
}
.roto-video__seq-handle {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 3px;
  margin-left: -1px;
  border-radius: 2px;
  background: #fff;
  pointer-events: none;
}
.roto-video__seq-readout {
  flex: none;
  font-size: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--text-faint);
  white-space: nowrap;
}
.roto-video__compare-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.roto-video__compare-btn,
.roto-video__layout-btn {
  padding: 2px 8px;
  font-size: 10px;
  font-family: inherit;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  cursor: pointer;
}
.roto-video__compare-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.roto-video__compare-btn--active {
  color: var(--accent, #6ea8fe);
  border-color: var(--accent, #6ea8fe);
  background: rgba(110,168,254,0.10);
}
/* Comparison split pane */
.roto-compare {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  gap: 1px;
  background: var(--border-soft);
}
.roto-compare--side-by-side {
  flex-direction: row;
}
.roto-compare--stacked {
  flex-direction: column;
}
.roto-compare__half {
  position: relative;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  overflow: hidden;
}
.roto-compare__half--seq {
  /* Checkerboard so transparent rotoscope cut-outs read cleanly. */
  background-color: #1a1d24;
  background-image:
    linear-gradient(45deg, #2a2e38 25%, transparent 25%),
    linear-gradient(-45deg, #2a2e38 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #2a2e38 75%),
    linear-gradient(-45deg, transparent 75%, #2a2e38 75%);
  background-size: 20px 20px;
  background-position: 0 0, 0 10px, 10px -10px, -10px 0;
}
.roto-compare__vid {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.roto-compare__img {
  display: block;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.roto-compare__tag {
  position: absolute;
  top: 6px;
  left: 8px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgba(255,255,255,0.5);
  pointer-events: none;
}
`;
