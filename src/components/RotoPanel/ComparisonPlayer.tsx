import {
  useRef,
  useState,
  useEffect,
  useMemo,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { LoadedSequence } from "../../store/rotoStore";

interface ComparisonPlayerProps {
  videoUrl: string;
  sequence: LoadedSequence;
  /** Clip span in seconds (clipEnd - clipStart when set, else full source duration). */
  effectiveDuration: number;
  fps: number;
  frameSkip: number;
  layout: "side-by-side" | "stacked";
}

function fmtTime(s: number): string {
  const safe = Math.max(0, s);
  const m = Math.floor(safe / 60);
  const sec = Math.floor(safe % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** Resync the output video to the master clock only past this drift (seconds).
 * Both clips span the same duration, so they free-run together once started;
 * nudging every frame would seek-stall the output and reintroduce stutter. */
const DRIFT_TOLERANCE = 0.15;

/**
 * Comparison split + shared timeline. The SOURCE video (source_clip.mp4) is the
 * master clock.
 *
 * When the output folder has a composed `output.webm` (`sequence.videoUrl`), the
 * output half is a real <video> decoded off the main thread and slaved to the
 * master on drift — smooth playback at the output's true fps, no per-frame work.
 * Older outputs without a webm fall back to swapping the PNG `sequence.urls`
 * frame-by-frame, derived from the shared clock. Either way both halves stay
 * time-aligned: the rotoscoped output is genuinely fps/(frameSkip+1) and spans
 * the same wall-clock as the source clip.
 *
 * A single rAF loop advances the scrubber off the master's currentTime and, for
 * the video path, applies the drift correction. Seeking pauses the loop, seeks
 * both videos, then resumes if playback was active.
 */
export default function ComparisonPlayer({
  videoUrl,
  sequence,
  effectiveDuration,
  fps,
  frameSkip,
  layout,
}: ComparisonPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const outVideoRef = useRef<HTMLVideoElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const wasPlayingRef = useRef(false);

  const [sharedTime, setSharedTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);

  const count = sequence.urls.length;
  const outputVideoUrl = sequence.videoUrl;
  const hasOutputVideo = Boolean(outputVideoUrl);

  // Output frame index for the readout (and the PNG-fallback image), derived
  // from the shared clock. The output advances at fps/(frameSkip+1) of source.
  const deriveFrame = (t: number) =>
    Math.min(count - 1, Math.max(0, Math.round((t * fps) / (frameSkip + 1))));
  const displayFrame = deriveFrame(sharedTime);

  const syncOutputVideo = (t: number) => {
    const out = outVideoRef.current;
    if (out && Math.abs(out.currentTime - t) > DRIFT_TOLERANCE) {
      out.currentTime = t;
    }
  };

  // rAF loop — active only while playing and not scrubbing. Reads the master
  // (source) clock to drive the scrubber, and nudges the output video back into
  // alignment when it drifts. No per-frame PNG swapping on the video path.
  useEffect(() => {
    if (!playing || scrubbing) return;
    const tick = () => {
      const vid = videoRef.current;
      if (vid) {
        setSharedTime(vid.currentTime);
        if (hasOutputVideo) syncOutputVideo(vid.currentTime);
        if (vid.ended) {
          outVideoRef.current?.pause();
          setPlaying(false);
          return;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, scrubbing, fps, frameSkip, count, hasOutputVideo]);

  const cancelRaf = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const pauseBoth = () => {
    videoRef.current?.pause();
    outVideoRef.current?.pause();
  };

  const playBoth = () => {
    void videoRef.current?.play();
    void outVideoRef.current?.play();
  };

  const applySeek = (t: number) => {
    const clamped = Math.min(Math.max(0, t), Math.max(0, effectiveDuration));
    if (videoRef.current) videoRef.current.currentTime = clamped;
    if (outVideoRef.current) outVideoRef.current.currentTime = clamped;
    setSharedTime(clamped);
  };

  const togglePlay = () => {
    const vid = videoRef.current;
    if (!vid) return;
    if (playing) {
      pauseBoth();
      cancelRaf();
      setPlaying(false);
    } else {
      playBoth();
      setPlaying(true);
    }
  };

  const getTimeFromPointer = (clientX: number): number => {
    const track = trackRef.current;
    if (!track || effectiveDuration <= 0) return 0;
    const rect = track.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return frac * effectiveDuration;
  };

  const onTrackPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    wasPlayingRef.current = playing;
    if (playing) {
      pauseBoth();
      cancelRaf();
      setPlaying(false);
    }
    setScrubbing(true);
    applySeek(getTimeFromPointer(e.clientX));
  };

  const onTrackPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!scrubbing) return;
    applySeek(getTimeFromPointer(e.clientX));
  };

  const onTrackPointerUp = () => {
    setScrubbing(false);
    if (wasPlayingRef.current) {
      playBoth();
      setPlaying(true);
    }
  };

  const pct =
    effectiveDuration > 0
      ? Math.min(100, (sharedTime / effectiveDuration) * 100)
      : 0;

  // PNG fallback only (older outputs with no output.webm). Hidden preload of
  // every frame so the swap loop is flicker-free; memoized on the url list so a
  // scrubber re-render never re-reconciles the whole <img> list. Skipped
  // entirely when the output video is available.
  const preloadStrip = useMemo(
    () =>
      hasOutputVideo ? null : (
        <div className="roto-video__seq-preload" aria-hidden>
          {sequence.urls.map((u) => (
            <img key={u} src={u} alt="" />
          ))}
        </div>
      ),
    [hasOutputVideo, sequence.urls],
  );

  return (
    <div className="roto-cmp">
      <style>{STYLES}</style>
      {/* Split view */}
      <div className={`roto-compare roto-compare--${layout}`}>
        <div className="roto-compare__half">
          <video
            ref={videoRef}
            className="roto-compare__vid"
            src={videoUrl}
            playsInline
          />
          <span className="roto-compare__tag">Source</span>
        </div>
        <div className="roto-compare__half roto-compare__half--seq">
          {hasOutputVideo ? (
            <video
              ref={outVideoRef}
              className="roto-compare__vid"
              src={outputVideoUrl}
              muted
              playsInline
            />
          ) : sequence.urls[displayFrame] ? (
            <img
              className="roto-compare__img"
              src={sequence.urls[displayFrame]}
              alt="rotoscoped frame"
              draggable={false}
            />
          ) : null}
          <span className="roto-compare__tag">Output</span>
          {preloadStrip}
        </div>
      </div>

      {/* Shared timeline */}
      <div className="roto-cmp__timeline">
        <button
          type="button"
          className="roto-cmp__play-btn"
          onClick={togglePlay}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? "Pause" : "Play"}
        </button>

        <div
          ref={trackRef}
          className="roto-cmp__track"
          onPointerDown={onTrackPointerDown}
          onPointerMove={onTrackPointerMove}
          onPointerUp={onTrackPointerUp}
          title="Drag to scrub"
        >
          <div className="roto-cmp__fill" style={{ width: `${pct}%` }} />
          <div className="roto-cmp__playhead" style={{ left: `${pct}%` }} />
        </div>

        <span className="roto-cmp__time">
          {fmtTime(sharedTime)} / {fmtTime(effectiveDuration)}
        </span>
        <span className="roto-cmp__frames">
          f&nbsp;{displayFrame + 1}&nbsp;/&nbsp;{count}
        </span>
      </div>
    </div>
  );
}

const STYLES = `
.roto-cmp {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
.roto-cmp__timeline {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-top: 1px solid var(--border-soft);
  background: var(--surface-alt);
  flex-shrink: 0;
}
.roto-cmp__play-btn {
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
.roto-cmp__track {
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
.roto-cmp__fill {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  border-radius: 5px 0 0 5px;
  background: var(--accent, #6ea8fe);
  opacity: 0.55;
  pointer-events: none;
}
.roto-cmp__playhead {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 3px;
  margin-left: -1px;
  border-radius: 2px;
  background: #fff;
  pointer-events: none;
}
.roto-cmp__time {
  flex: none;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--text-muted);
  white-space: nowrap;
}
.roto-cmp__frames {
  flex: none;
  font-size: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--text-faint);
  white-space: nowrap;
}
`;
