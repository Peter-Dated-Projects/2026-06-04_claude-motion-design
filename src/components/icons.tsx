// Small inline SVG icons shared across the toolbar/panel menus. Using real SVG
// elements (instead of unicode glyphs like "▾" or stray letters "v"/"x") keeps
// the chrome crisp at any zoom and lets icons inherit color via `currentColor`.
//
// All icons render at 1em by default so they scale with the surrounding font
// size; pass `size` to override. They take `currentColor` so a button's text
// color drives the stroke.

interface IconProps {
  size?: number;
  className?: string;
}

const base = (size: number, className?: string) => ({
  width: size,
  height: size,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  className,
});

export function ChevronDownIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M4 6.5 8 10.5l4-4" />
    </svg>
  );
}

export function CheckIcon({ size = 13, className }: IconProps) {
  return (
    <svg {...base(size, className)} strokeWidth={2}>
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  );
}

export function GearIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.4v1.9M8 12.7v1.9M3.34 3.34l1.34 1.34M11.32 11.32l1.34 1.34M1.4 8h1.9M12.7 8h1.9M3.34 12.66l1.34-1.34M11.32 4.68l1.34-1.34" />
    </svg>
  );
}

export function SunIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.2v1.6M8 13.2v1.6M2.4 2.4l1.1 1.1M12.5 12.5l1.1 1.1M1.2 8h1.6M13.2 8h1.6M2.4 13.6l1.1-1.1M12.5 3.5l1.1-1.1" />
    </svg>
  );
}

export function MoonIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M13.2 9.4A5.2 5.2 0 0 1 6.6 2.8 5.4 5.4 0 1 0 13.2 9.4Z" />
    </svg>
  );
}

export function CloseIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...base(size, className)} strokeWidth={1.8}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
