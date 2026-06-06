import { useState } from "react";

/**
 * Modal shown after clicking "Generate Rotoscope": offers optional local ffmpeg
 * compression before the clip is uploaded to the (possibly LAN-remote) service.
 *
 * The compress preference is a GLOBAL setting persisted across ALL projects (per
 * the proposal), not per-project, so it lives in localStorage rather than project
 * metadata. Defaults: compression OFF, quality 80%.
 */

const COMPRESS_KEY = "claude-motion:rotoCompress";
const QUALITY_KEY = "claude-motion:rotoQuality";

const DEFAULT_COMPRESS = false;
const DEFAULT_QUALITY = 80;

/** Read the persisted global compression preference (defaults if unset/corrupt). */
export function loadCompressionPref(): { compress: boolean; quality: number } {
  let compress = DEFAULT_COMPRESS;
  let quality = DEFAULT_QUALITY;
  try {
    compress = localStorage.getItem(COMPRESS_KEY) === "1";
    const q = Number(localStorage.getItem(QUALITY_KEY));
    if (Number.isFinite(q) && q >= 1 && q <= 100) quality = q;
  } catch {
    /* private-mode / disabled storage: fall back to defaults */
  }
  return { compress, quality };
}

function saveCompressionPref(compress: boolean, quality: number) {
  try {
    localStorage.setItem(COMPRESS_KEY, compress ? "1" : "0");
    localStorage.setItem(QUALITY_KEY, String(quality));
  } catch {
    /* non-fatal: the choice still applies to this job via the callback */
  }
}

interface CompressionModalProps {
  /** Persist the choice globally and start the job with these params. */
  onConfirm: (compress: boolean, quality: number) => void;
  onCancel: () => void;
}

export default function CompressionModal({
  onConfirm,
  onCancel,
}: CompressionModalProps) {
  const initial = loadCompressionPref();
  const [compress, setCompress] = useState(initial.compress);
  const [quality, setQuality] = useState(initial.quality);

  const confirm = () => {
    saveCompressionPref(compress, quality);
    onConfirm(compress, quality);
  };

  return (
    <div
      className="roto-modal__backdrop"
      onPointerDown={(e) => {
        // Click outside the card cancels (matches a standard dismiss gesture).
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <style>{STYLES}</style>
      <div
        className="roto-modal__card"
        role="dialog"
        aria-modal="true"
        aria-label="Compress video before sending"
      >
        <div className="roto-modal__title">Compress video before sending?</div>
        <div className="roto-modal__body">
          Smaller file = faster transfer to the rotoscoping service.
        </div>

        <label className="roto-modal__toggle">
          <input
            type="checkbox"
            checked={compress}
            onChange={(e) => setCompress(e.target.checked)}
          />
          <span>Compress with ffmpeg before upload</span>
        </label>

        <div
          className={
            "roto-modal__quality" +
            (compress ? "" : " roto-modal__quality--disabled")
          }
        >
          <div className="roto-modal__quality-head">
            <span>Quality</span>
            <strong>{quality}%</strong>
          </div>
          <input
            type="range"
            min={1}
            max={100}
            value={quality}
            disabled={!compress}
            onChange={(e) => setQuality(Number(e.target.value))}
          />
        </div>

        <div className="roto-modal__actions">
          <button
            type="button"
            className="roto-modal__btn"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="roto-modal__btn roto-modal__btn--primary"
            onClick={confirm}
          >
            Rotoscope
          </button>
        </div>
      </div>
    </div>
  );
}

const STYLES = `
.roto-modal__backdrop {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0,0,0,0.5);
  padding: 16px;
}
.roto-modal__card {
  width: 100%;
  max-width: 360px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  box-shadow: 0 12px 32px rgba(0,0,0,0.45);
}
.roto-modal__title {
  font-size: 14px;
  font-weight: 600;
}
.roto-modal__body {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}
.roto-modal__toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}
.roto-modal__quality {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.roto-modal__quality--disabled {
  opacity: 0.45;
}
.roto-modal__quality-head {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-muted);
}
.roto-modal__quality input[type="range"] {
  width: 100%;
}
.roto-modal__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
.roto-modal__btn {
  padding: 6px 16px;
  font-size: 13px;
  font-family: inherit;
  color: var(--text);
  background: var(--surface-alt);
  border: 1px solid var(--border-soft);
  border-radius: 5px;
  cursor: pointer;
}
.roto-modal__btn--primary {
  color: #fff;
  background: var(--accent, #6ea8fe);
  border-color: var(--accent, #6ea8fe);
  font-weight: 600;
}
`;
