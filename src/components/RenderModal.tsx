import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import PreviewPanel from "./PreviewPanel/PreviewPanel";
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

const INSTALL_PHASE_LABEL: Record<string, string> = {
  download: "Downloading",
  verify: "Verifying",
  extract: "Unpacking",
};

type Phase = "config" | "installing" | "rendering" | "done" | "error";

interface RenderModalProps {
  open: boolean;
  slug: string | null;
  code?: string;
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

function RenderModal({ open, slug, code, onClose }: RenderModalProps) {
  const [phase, setPhase] = useState<Phase>("config");
  const [formatKey, setFormatKey] = useState("h264");
  const [quality, setQuality] = useState("high");
  const [outPath, setOutPath] = useState<string | null>(null);
  const [renderProgress, setRenderProgress] = useState(0);
  const [install, setInstall] = useState<{ phase: string; progress: number } | null>(
    null,
  );
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const format = FORMATS.find((f) => f.key === formatKey) ?? FORMATS[0];
  const busy = phase === "installing" || phase === "rendering";

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
            <PreviewPanel code={code} />
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

                {format.codec !== "gif" && (
                  <label className="rendermodal__field">
                    <span className="rendermodal__label">Quality</span>
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
