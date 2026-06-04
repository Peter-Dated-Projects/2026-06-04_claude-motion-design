import type { CSSProperties } from "react";
import type { SafeZonePlatform } from "../../store/uiStore";

// Inset (px) from each edge of the 1080x1920 frame where the platform's own UI sits.
// Content must stay OUT of these regions to remain visible. Values are empirical
// per-platform measurements; "universal" takes the most conservative inset of all three.
const SAFE_ZONES: Record<
  SafeZonePlatform,
  { top: number; bottom: number; left: number; right: number }
> = {
  universal: { top: 140, bottom: 370, left: 30, right: 160 },
  tiktok: { top: 140, bottom: 370, left: 30, right: 150 },
  instagram: { top: 130, bottom: 340, left: 30, right: 160 },
  youtube: { top: 140, bottom: 360, left: 30, right: 160 },
};

const UNSAFE_FILL = "rgba(255,0,0,0.12)";
const SAFE_BORDER = "rgba(255,200,0,0.8)";
const LABEL_COLOR = "rgba(255,255,255,0.55)";

interface SafeZoneOverlayProps {
  show: boolean;
  platform: SafeZonePlatform;
  /**
   * The scale factor PreviewPanel applies to the 1080x1920 stage. The overlay lives
   * inside that down-scaled coordinate space, so border widths and label fonts are
   * divided by `scale` to render at a crisp, fixed on-screen size.
   */
  scale: number;
}

/**
 * Absolutely-positioned, non-interactive overlay drawn over the preview iframe. Shades
 * the four unsafe edge regions, outlines the safe content area, and labels the two
 * regions creators most often misplace content into.
 */
function SafeZoneOverlay({ show, platform, scale }: SafeZoneOverlayProps) {
  if (!show) return null;

  const zone = SAFE_ZONES[platform];
  // Keep stroke/text at a fixed visual size despite the stage being scaled down.
  const px = (n: number) => n / (scale || 1);

  const fillBase: CSSProperties = {
    position: "absolute",
    background: UNSAFE_FILL,
  };

  const labelBase: CSSProperties = {
    position: "absolute",
    color: LABEL_COLOR,
    fontFamily: "sans-serif",
    fontSize: px(12),
    letterSpacing: "0.04em",
    pointerEvents: "none",
  };

  return (
    <div
      aria-hidden
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
    >
      {/* Unsafe strips. Top/bottom span full width; left/right fill only the gap
          between them so the corners aren't double-shaded. */}
      <div style={{ ...fillBase, top: 0, left: 0, right: 0, height: zone.top }} />
      <div
        style={{ ...fillBase, bottom: 0, left: 0, right: 0, height: zone.bottom }}
      />
      <div
        style={{
          ...fillBase,
          top: zone.top,
          bottom: zone.bottom,
          left: 0,
          width: zone.left,
        }}
      />
      <div
        style={{
          ...fillBase,
          top: zone.top,
          bottom: zone.bottom,
          right: 0,
          width: zone.right,
        }}
      />

      {/* Inner-edge border around the safe content area. */}
      <div
        style={{
          position: "absolute",
          top: zone.top,
          bottom: zone.bottom,
          left: zone.left,
          right: zone.right,
          border: `${px(1)}px solid ${SAFE_BORDER}`,
        }}
      />

      {/* Region labels. */}
      <div
        style={{
          ...labelBase,
          left: zone.left + px(8),
          bottom: zone.bottom - px(20),
        }}
      >
        Caption area
      </div>
      <div
        style={{
          ...labelBase,
          right: px(8),
          top: "50%",
          transform: "translateY(-50%)",
          width: zone.right,
          textAlign: "center",
        }}
      >
        Action buttons
      </div>
    </div>
  );
}

export default SafeZoneOverlay;
