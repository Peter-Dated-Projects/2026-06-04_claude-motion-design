import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import PreviewPanel from "./PreviewPanel/PreviewPanel";
import { ENTRY_FILE } from "./CodePanel/CodePanel";
import { CloseIcon } from "./icons";

// Video-export modal. Opens BEFORE rendering: pick a save location, a format +
// quality, see a live preview of what will render, then click Render. The same
// modal then shows progress (installing the render toolchain on first use, then
// the render itself) and a final saved/error state.
//
// File selection is decoupled from the render: `choose_render_output` opens the
// native save dialog and returns a path; `export_mp4` then renders to it with the
// chosen codec/quality. The render toolchain (Node + Remotion) is downloaded on
// first use via install_render_toolchain (see render_toolchain.rs).

const TOOLCHAIN_MISSING = "TOOLCHAIN_MISSING";

interface Format {
  key: string;
  label: string;
  codec: string;
  ext: string;
}

const FORMATS: Format[] = [
  { key: "h264", label: "MP4 · H.264", codec: "h264", ext: "mp4" },
  { key: "h265", label: "MP4 · H.265 (HEVC)", codec: "h265", ext: "mp4" },
  { key: "vp9", label: "WebM · VP9", codec: "vp9", ext: "webm" },
  { key: "gif", label: "GIF", codec: "gif", ext: "gif" },
];

const QUALITIES = [
  { key: "high", label: "High" },
  { key: "medium", label: "Medium" },
  { key: "low", label: "Low" },
];

// Composition dimensions (fixed; see render-mp4.mjs / the preview sandbox).
const COMP_WIDTH = 1080;
const COMP_HEIGHT = 1920;

// For a GIF, "Quality" controls only the output resolution: the scale applied to
// the 1080x1920 composition. Frame rate is a separate control. Keep in sync with
// GIF_SCALE_BY_QUALITY in scripts/render-mp4.mjs.
const GIF_SCALE_BY_QUALITY: Record<string, number> = {
  high: 0.5,
  medium: 0.375,
  low: 0.25,
};

// GIF frame-rate choices. The render script drops frames to hit the target
// (every Nth source frame), so values above the animation's own fps just render
// every frame. 15 is a sensible default for shareable GIFs.
const GIF_FPS_OPTIONS = [30, 24, 15, 10];
const DEFAULT_GIF_FPS = 15;

// Lossy gifsicle post-process levels. The size multipliers are rough averages of
// the savings gifsicle yields at each level, used only to nudge the estimate.
// Keep keys in sync with GIF_COMPRESS_ARGS in scripts/render-mp4.mjs.
const GIF_COMPRESSION_OPTIONS = [
  { key: "none", label: "None", factor: 1 },
  { key: "light", label: "Light", factor: 0.4 },
  { key: "strong", label: "Strong", factor: 0.2 },
];

// Default timing if the animation doesn't export fps / durationInFrames. Must
// match DEFAULT_FPS / DEFAULT_DURATION_IN_FRAMES in scripts/render-mp4.mjs.
const DEFAULT_FPS = 30;
const DEFAULT_DURATION_IN_FRAMES = 150;

// Rough bytes per (pixel x output-frame) for a GIF, calibrated from a real render
// (405x720, 60 frames -> ~1.92 MB). GIF size is content-dependent (palette, motion,
// flat vs. busy), so this is an order-of-magnitude estimate, not a guarantee.
const GIF_BYTES_PER_PIXEL_FRAME = 0.11;

// Pull fps + durationInFrames out of the animation source the same way the render
// script does: explicit `export const fps` / `durationInFrames`, else a
// `export const config = { fps, durationInFrames }`, else the defaults.
function readTiming(src: string | undefined): { fps: number; durationInFrames: number } {
  const num = (re: RegExp, fallback: number) => {
    const m = src?.match(re);
    const n = m ? Number(m[1]) : NaN;
    return isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    fps: num(/\bfps\s*[=:]\s*([0-9]*\.?[0-9]+)/, DEFAULT_FPS),
    durationInFrames: num(
      /\bdurationInFrames\s*[=:]\s*([0-9]*\.?[0-9]+)/,
      DEFAULT_DURATION_IN_FRAMES,
    ),
  };
}

// Estimate a GIF's file size from its settings. everyNthFrame mirrors the render
// script: round(sourceFps / targetFps), floored at 1 (can't add frames).
function estimateGifBytes(
  quality: string,
  gifFps: number,
  compression: string,
  timing: { fps: number; durationInFrames: number },
): number {
  const scale = GIF_SCALE_BY_QUALITY[quality] ?? GIF_SCALE_BY_QUALITY.high;
  const w = Math.round(COMP_WIDTH * scale);
  const h = Math.round(COMP_HEIGHT * scale);
  const everyNthFrame = Math.max(1, Math.round(timing.fps / gifFps));
  const outFrames = Math.max(1, Math.ceil(timing.durationInFrames / everyNthFrame));
  const factor =
    GIF_COMPRESSION_OPTIONS.find((c) => c.key === compression)?.factor ?? 1;
  return w * h * outFrames * GIF_BYTES_PER_PIXEL_FRAME * factor;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const INSTALL_PHASE_LABEL: Record<string, string> = {
  download: "Downloading",
  verify: "Verifying",
  extract: "Unpacking",
};

type Phase = "config" | "installing" | "rendering" | "done" | "error";

interface RenderModalProps {
  open: boolean;
  slug: string | null;
  /** The project's full `.ts`/`.tsx` map (siblings + `animation.tsx`). The preview
   *  bundles `animation.tsx` against this, so relative imports like `./theme` resolve
   *  here exactly as they do in the main editor preview. */
  files?: Record<string, string>;
  onClose: () => void;
}

const OVERLAY: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay-veil)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  fontFamily: "Inter, sans-serif",
};

const CARD: React.CSSProperties = {
  width: 920,
  maxWidth: "94vw",
  height: 560,
  maxHeight: "90vh",
  background: "var(--elevated)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  boxShadow: "0 24px 80px var(--shadow)",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

function RenderModal({ open, slug, files, onClose }: RenderModalProps) {
  const [phase, setPhase] = useState<Phase>("config");
  const [formatKey, setFormatKey] = useState("h264");
  const [quality, setQuality] = useState("high");
  const [gifFps, setGifFps] = useState(DEFAULT_GIF_FPS);
  const [gifCompression, setGifCompression] = useState("none");
  const [outPath, setOutPath] = useState<string | null>(null);
  const [renderProgress, setRenderProgress] = useState(0);
  const [install, setInstall] = useState<{ phase: string; progress: number } | null>(
    null,
  );
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const format = FORMATS.find((f) => f.key === formatKey) ?? FORMATS[0];
  const busy = phase === "installing" || phase === "rendering";

  // GIF-only derived values: output resolution (from quality) and an estimated
  // file size (from resolution x frame count, calibrated from a real render).
  const isGif = format.codec === "gif";
  const gifScale = GIF_SCALE_BY_QUALITY[quality] ?? GIF_SCALE_BY_QUALITY.high;
  const gifDims = `${Math.round(COMP_WIDTH * gifScale)} × ${Math.round(COMP_HEIGHT * gifScale)}`;
  const gifEstimate = isGif
    ? formatBytes(
        estimateGifBytes(
          quality,
          gifFps,
          gifCompression,
          readTiming(files?.[ENTRY_FILE]),
        ),
      )
    : null;

  // Reset to a clean config state each time the modal opens.
  useEffect(() => {
    if (open) {
      setPhase("config");
      setRenderProgress(0);
      setInstall(null);
      setSavedPath(null);
      setErrorMsg(null);
    }
  }, [open]);

  if (!open) return null;

  // Swap the chosen file's extension when the format changes, keeping its folder
  // and name so the user doesn't have to re-pick the location.
  const onFormatChange = (key: string) => {
    setFormatKey(key);
    const next = FORMATS.find((f) => f.key === key);
    if (next && outPath) {
      setOutPath(outPath.replace(/\.[^/.]+$/, `.${next.ext}`));
    }
  };

  const chooseLocation = async () => {
    if (!slug) return;
    try {
      const picked = await invoke<string | null>("choose_render_output", {
        slug,
        ext: format.ext,
      });
      if (picked) setOutPath(picked);
    } catch (err) {
      setErrorMsg(String(err));
      setPhase("error");
    }
  };

  const doRender = async () => {
    if (!slug || !outPath) return;
    setPhase("rendering");
    setRenderProgress(0);
    const unlisten = await listen<{ progress: number }>(
      "export://progress",
      (e) => setRenderProgress(e.payload.progress),
    );
    try {
      const path = await invoke<string>("export_mp4", {
        slug,
        outPath,
        codec: format.codec,
        quality,
        gifFps: isGif ? gifFps : null,
        gifCompression: isGif ? gifCompression : null,
      });
      setSavedPath(path);
      setPhase("done");
    } catch (err) {
      const message = String(err);
      if (message === TOOLCHAIN_MISSING) {
        unlisten();
        void installThenRender();
        return;
      }
      setErrorMsg(message);
      setPhase("error");
    } finally {
      unlisten();
    }
  };

  const installThenRender = async () => {
    setPhase("installing");
    setInstall({ phase: "download", progress: 0 });
    const unlisten = await listen<{ phase: string; progress: number }>(
      "toolchain://progress",
      (e) => setInstall(e.payload),
    );
    try {
      await invoke("install_render_toolchain");
    } catch (err) {
      setErrorMsg(`Install failed: ${String(err)}`);
      setPhase("error");
      unlisten();
      setInstall(null);
      return;
    }
    unlisten();
    setInstall(null);
    void doRender();
  };

  // Render entry: install the toolchain first if it isn't available yet.
  const onRenderClick = async () => {
    if (!slug || !outPath) return;
    try {
      const status = await invoke<{ installed: boolean }>(
        "render_toolchain_status",
      );
      if (!status.installed) {
        void installThenRender();
        return;
      }
    } catch {
      // fall through to render; it surfaces the real error
    }
    void doRender();
  };

  const fileName = outPath ? outPath.split("/").pop() : null;

  return (
    <div
      style={OVERLAY}
      onMouseDown={(e) => {
        // Click outside to dismiss, but never mid-render.
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div style={CARD}>
        <header className="rendermodal__header">
          <span className="rendermodal__title">Export video</span>
          <button
            type="button"
            className="rendermodal__close"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="rendermodal__body">
          {/* Live preview of what will render. */}
          <div className="rendermodal__preview">
            <PreviewPanel files={files} embedded />
          </div>

          {/* Right rail: config, or progress/result by phase. */}
          <div className="rendermodal__rail">
            {phase === "config" && (
              <>
                <label className="rendermodal__field">
                  <span className="rendermodal__label">Format</span>
                  <select
                    className="rendermodal__select"
                    value={formatKey}
                    onChange={(e) => onFormatChange(e.target.value)}
                  >
                    {FORMATS.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="rendermodal__field">
                  <span className="rendermodal__label">
                    {isGif ? "Quality (resolution)" : "Quality"}
                  </span>
                  <select
                    className="rendermodal__select"
                    value={quality}
                    onChange={(e) => setQuality(e.target.value)}
                  >
                    {QUALITIES.map((q) => (
                      <option key={q.key} value={q.key}>
                        {q.label}
                      </option>
                    ))}
                  </select>
                  {isGif && <span className="rendermodal__hint">{gifDims}</span>}
                </label>

                {isGif && (
                  <label className="rendermodal__field">
                    <span className="rendermodal__label">Frame rate</span>
                    <select
                      className="rendermodal__select"
                      value={gifFps}
                      onChange={(e) => setGifFps(Number(e.target.value))}
                    >
                      {GIF_FPS_OPTIONS.map((f) => (
                        <option key={f} value={f}>
                          {f} fps
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {isGif && (
                  <label className="rendermodal__field">
                    <span className="rendermodal__label">Compression (lossy)</span>
                    <select
                      className="rendermodal__select"
                      value={gifCompression}
                      onChange={(e) => setGifCompression(e.target.value)}
                    >
                      {GIF_COMPRESSION_OPTIONS.map((c) => (
                        <option key={c.key} value={c.key}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                    {gifEstimate && (
                      <span className="rendermodal__hint">
                        Est. size ~{gifEstimate}
                      </span>
                    )}
                  </label>
                )}

                <div className="rendermodal__field">
                  <span className="rendermodal__label">Save to</span>
                  <button
                    type="button"
                    className="rendermodal__choose"
                    onClick={() => void chooseLocation()}
                  >
                    {fileName ? "Change location…" : "Choose location…"}
                  </button>
                  {fileName && (
                    <span className="rendermodal__path" title={outPath ?? ""}>
                      {fileName}
                    </span>
                  )}
                </div>

                <div className="rendermodal__spacer" />

                <button
                  type="button"
                  className="rendermodal__render"
                  disabled={!slug || !outPath}
                  onClick={() => void onRenderClick()}
                >
                  Render
                </button>
              </>
            )}

            {phase === "installing" && (
              <div className="rendermodal__status">
                <span className="rendermodal__label">
                  {INSTALL_PHASE_LABEL[install?.phase ?? "download"] ??
                    "Installing"}{" "}
                  renderer…
                </span>
                <ProgressBar
                  value={install?.phase === "download" ? install.progress : null}
                />
                <p className="rendermodal__hint">
                  One-time setup of the video renderer.
                </p>
              </div>
            )}

            {phase === "rendering" && (
              <div className="rendermodal__status">
                <span className="rendermodal__label">
                  Rendering… {Math.round(renderProgress * 100)}%
                </span>
                <ProgressBar value={renderProgress} />
                <p className="rendermodal__hint">
                  The first render also downloads a headless browser, so it can
                  take longer.
                </p>
              </div>
            )}

            {phase === "done" && (
              <div className="rendermodal__status">
                <span className="rendermodal__label">Saved</span>
                <span className="rendermodal__path" title={savedPath ?? ""}>
                  {savedPath?.split("/").pop()}
                </span>
                <div className="rendermodal__spacer" />
                <button
                  type="button"
                  className="rendermodal__render"
                  onClick={onClose}
                >
                  Done
                </button>
              </div>
            )}

            {phase === "error" && (
              <div className="rendermodal__status">
                <span className="rendermodal__label rendermodal__label--error">
                  Render failed
                </span>
                <p className="rendermodal__error">{errorMsg}</p>
                <div className="rendermodal__spacer" />
                <button
                  type="button"
                  className="rendermodal__choose"
                  onClick={() => setPhase("config")}
                >
                  Back
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// A thin progress bar. `value` is 0..1, or null for an indeterminate phase.
function ProgressBar({ value }: { value: number | null }) {
  return (
    <div className="rendermodal__bar">
      <div
        className={`rendermodal__bar-fill${value === null ? " rendermodal__bar-fill--indeterminate" : ""}`}
        style={value === null ? undefined : { width: `${Math.round(value * 100)}%` }}
      />
    </div>
  );
}

export default RenderModal;
