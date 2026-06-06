import { useEffect, useRef, useState } from "react";
import { useRotoStore } from "../../store/rotoStore";
import type { PointLabel } from "../../types/roto";

/**
 * Canvas overlay for placing SAM2 prompt points on the LOCKED reference frame.
 *
 * Renders its own <video> seeked to the reference time (a paused frame is the
 * cheapest way to show a single decoded frame without a separate capture step),
 * with a transparent <canvas> stretched over it for click capture + dot drawing.
 *
 * Interaction (per the proposal):
 *   - Left-click  -> foreground point (green dot, label 1)
 *   - Right-click -> background exclusion point (red dot, label 0)
 *   - Multiple of each; "Clear Points" wipes the set; native context menu is
 *     suppressed so right-click is usable as a placement gesture.
 *
 * Points are stored in the reference frame's NATURAL pixel space (videoWidth/
 * videoHeight), not display space, so they round-trip unchanged into the
 * `rotoscope_video` command and the backend's meta.json regardless of how the
 * pane is sized. The canvas internal resolution is the natural size; the click
 * handler scales display coords back up by the canvas's rendered rect.
 */

interface PointOverlayProps {
  /** Asset-protocol URL for the source video (already convertFileSrc'd). */
  videoSrc: string;
  /** Locked reference frame, expressed as a time offset in seconds. */
  referenceTimeSeconds: number;
}

const FG_COLOR = "#3ddc84"; // foreground (keep)
const BG_COLOR = "#ff5c5c"; // background (exclude)

export default function PointOverlay({
  videoSrc,
  referenceTimeSeconds,
}: PointOverlayProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  const points = useRotoStore((s) => s.points);
  const addPoint = useRotoStore((s) => s.addPoint);
  const clearPoints = useRotoStore((s) => s.clearPoints);

  // Seek the paused <video> to the locked frame once metadata is in, and capture
  // the natural dimensions that anchor the point coordinate space.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const onMeta = () => {
      setDims({ w: el.videoWidth, h: el.videoHeight });
      // Clamp the seek to the clip's range so a stale reference time can't park
      // the frame past the end (which would show a black frame).
      const t = Math.max(
        0,
        Math.min(referenceTimeSeconds, Math.max(0, el.duration - 0.001)),
      );
      try {
        el.currentTime = t;
      } catch {
        /* seeking before ready throws on some platforms; metadata retry covers it */
      }
    };
    el.addEventListener("loadedmetadata", onMeta);
    if (el.readyState >= 1) onMeta();
    return () => el.removeEventListener("loadedmetadata", onMeta);
  }, [videoSrc, referenceTimeSeconds]);

  // Redraw the dots whenever the point set or the natural dimensions change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !dims) return;
    canvas.width = dims.w;
    canvas.height = dims.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, dims.w, dims.h);
    // Scale dot size with frame width so points stay legible at any resolution.
    const radius = Math.max(5, Math.round(dims.w * 0.008));
    points.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = p.label === 1 ? FG_COLOR : BG_COLOR;
      ctx.fill();
      ctx.lineWidth = Math.max(1, Math.round(radius * 0.3));
      ctx.strokeStyle = "rgba(0,0,0,0.65)";
      ctx.stroke();
      // Placement-order index label, mirrors how the user reasons about points.
      ctx.fillStyle = "#000";
      ctx.font = `${Math.round(radius * 1.4)}px ui-monospace, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), p.x, p.y);
    });
  }, [points, dims]);

  const placePoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // Only react to primary (left) and secondary (right) buttons.
    if (e.button !== 0 && e.button !== 2) return;
    const canvas = canvasRef.current;
    if (!canvas || !dims) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // Map display-space click back into natural pixel space.
    const x = Math.round(((e.clientX - rect.left) / rect.width) * dims.w);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * dims.h);
    const label: PointLabel = e.button === 2 ? 0 : 1;
    addPoint({ x, y, label });
  };

  const fgCount = points.filter((p) => p.label === 1).length;
  const bgCount = points.length - fgCount;

  return (
    <div className="roto-overlay">
      <style>{STYLES}</style>
      <div className="roto-overlay__stage">
        <video
          ref={videoRef}
          className="roto-overlay__frame"
          src={videoSrc}
          muted
          playsInline
          preload="auto"
        />
        <canvas
          ref={canvasRef}
          className="roto-overlay__canvas"
          onPointerDown={placePoint}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
      <div className="roto-overlay__bar">
        <span className="roto-overlay__hint">
          <span className="roto-overlay__swatch roto-overlay__swatch--fg" />
          left-click = foreground ({fgCount})
          <span className="roto-overlay__swatch roto-overlay__swatch--bg" />
          right-click = exclude ({bgCount})
        </span>
        <button
          type="button"
          className="roto-overlay__clear"
          onClick={() => clearPoints()}
          disabled={points.length === 0}
        >
          Clear Points
        </button>
      </div>
    </div>
  );
}

const STYLES = `
.roto-overlay {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
}
.roto-overlay__stage {
  position: relative;
  width: 100%;
  line-height: 0;
  background: #000;
  border-radius: 6px;
  overflow: hidden;
}
.roto-overlay__frame {
  display: block;
  width: 100%;
  height: auto;
  max-height: 60vh;
  object-fit: contain;
}
.roto-overlay__canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  cursor: crosshair;
  touch-action: none;
}
.roto-overlay__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.roto-overlay__hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-faint);
}
.roto-overlay__swatch {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1px solid rgba(0,0,0,0.5);
}
.roto-overlay__swatch--fg { background: ${FG_COLOR}; }
.roto-overlay__swatch--bg { background: ${BG_COLOR}; margin-left: 6px; }
.roto-overlay__clear {
  padding: 3px 10px;
  font-size: 11px;
  font-family: inherit;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  cursor: pointer;
}
.roto-overlay__clear:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
`;
