import {
  useRef,
  useState,
  useEffect,
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

/**
 * Comparison split + shared timeline. Owns the source video element and the
 * rAF-driven sync loop so that both halves always show the same instant.
 *
 * rAF is the sole clock — no setInterval. Each tick reads video.currentTime,
 * derives the sequence frame as round(t * fps / (frameSkip + 1)), and schedules
 * the next tick. Seeking pauses the loop, seeks the video, derives the frame
 * immediately, then resumes if playback was active.
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
  const rafRef = useRef<number | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const wasPlayingRef = useRef(false);

  const [sharedTime, setSharedTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [comparisonFrame, setComparisonFrame] = useState(0);

  const count = sequence.urls.length;

  const deriveFrame = (t: number) =>
    Math.min(count - 1, Math.max(0, Math.round((t * fps) / (frameSkip + 1))));

  // rAF loop — active only while playing and not scrubbing.
  useEffect(() => {
    if (!playing || scrubbing) return;
    const tick = () => {
      const vid = videoRef.current;
      if (vid) {
        const t = vid.currentTime;
        setSharedTime(t);
        setComparisonFrame(deriveFrame(t));
        if (vid.ended) {
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
  }, [playing, scrubbing, fps, frameSkip, count]);

  const applySeek = (t: number) => {
    const clamped = Math.min(Math.max(0, t), Math.max(0, effectiveDuration));
    const vid = videoRef.current;
    if (vid) vid.currentTime = clamped;
    setSharedTime(clamped);
    setComparisonFrame(deriveFrame(clamped));
  };

  const cancelRaf = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const togglePlay = () => {
    const vid = videoRef.current;
    if (!vid) return;
    if (playing) {
      vid.pause();
      cancelRaf();
      setPlaying(false);
    } else {
      void vid.play();
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
      videoRef.current?.pause();
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
      void videoRef.current?.play();
      setPlaying(true);
    }
  };

  const pct =
    effectiveDuration > 0
      ? Math.min(100, (sharedTime / effectiveDuration) * 100)
      : 0;

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
          {sequence.urls[comparisonFrame] ? (
            <img
              className="roto-compare__img"
              src={sequence.urls[comparisonFrame]}
              alt="rotoscoped frame"
              draggable={false}
            />
          ) : null}
          <span className="roto-compare__tag">Output</span>
          {/* Hidden preload strip so first-pass loop is flicker-free. */}
          <div className="roto-video__seq-preload" aria-hidden>
            {sequence.urls.map((u) => (
              <img key={u} src={u} alt="" />
            ))}
          </div>
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
          f&nbsp;{comparisonFrame + 1}&nbsp;/&nbsp;{count}
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
