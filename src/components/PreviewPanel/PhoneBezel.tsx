import type { CSSProperties, ReactNode } from "react";

// The screen content area renders at the canonical 9:16 composition size; the bezel
// chrome wraps around it. Dimensions are in composition pixels and get scaled to fit
// the preview container by PreviewPanel.
const SCREEN_WIDTH = 1080;
const SCREEN_HEIGHT = 1920;
const BEZEL_PADDING = 12;
const BEZEL_BORDER = 2;

// Outer bezel size = screen + padding + border on each edge. PreviewPanel fits THESE
// dimensions (not the bare screen) so the bezel chrome never clips against the container.
export const BEZEL_OUTER_WIDTH = SCREEN_WIDTH + 2 * (BEZEL_PADDING + BEZEL_BORDER);
export const BEZEL_OUTER_HEIGHT = SCREEN_HEIGHT + 2 * (BEZEL_PADDING + BEZEL_BORDER);

const outerStyle: CSSProperties = {
  boxSizing: "border-box",
  width: BEZEL_OUTER_WIDTH,
  height: BEZEL_OUTER_HEIGHT,
  borderRadius: 48,
  boxShadow: "0 24px 80px rgba(0,0,0,0.7)",
  border: `${BEZEL_BORDER}px solid #333`,
  background: "#1a1a1a",
  padding: BEZEL_PADDING,
};

// Inner screen: clips its contents (the iframe + safe-zone overlay) to the rounded
// screen area. Relative-positioned so absolutely-positioned children anchor to it.
const screenStyle: CSSProperties = {
  position: "relative",
  width: SCREEN_WIDTH,
  height: SCREEN_HEIGHT,
  borderRadius: 4,
  overflow: "hidden",
  background: "#000",
};

// A rim drawn on TOP of the screen content so the device edge reads against black
// (#000) preview content. It is a zero-layout overlay (position:absolute, inset:0,
// pointer-events:none) so it changes none of the exported geometry and never
// disturbs the safe-zone overlay's coordinate frame. The bezel renders at
// composition size (1080x1920) then PreviewPanel CSS-scales it down to fit, so the
// rim is sized generously in composition pixels to survive the scale-down instead
// of vanishing to a sub-pixel hairline.
const screenRimStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  borderRadius: 4,
  border: "6px solid rgba(255,255,255,0.16)",
  boxShadow:
    "inset 0 0 0 2px rgba(0,0,0,0.7), inset 0 0 40px rgba(0,0,0,0.55)",
  pointerEvents: "none",
};

interface PhoneBezelProps {
  children: ReactNode;
}

/**
 * CSS-only phone silhouette. Renders a generic dark bezel around the preview; its
 * children fill the 1080x1920 inner screen. No external dependency.
 */
function PhoneBezel({ children }: PhoneBezelProps) {
  return (
    <div style={outerStyle}>
      <div style={screenStyle}>
        {children}
        <div style={screenRimStyle} aria-hidden />
      </div>
    </div>
  );
}

export default PhoneBezel;
