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
      <div style={screenStyle}>{children}</div>
    </div>
  );
}

export default PhoneBezel;
