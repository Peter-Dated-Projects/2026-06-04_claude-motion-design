import { useRotoStore, type QualityPreset } from "../../store/rotoStore";

/**
 * Confirmation shown after clicking "Generate Rotoscope".
 *
 * Settings (fps, resolution, quality) now live in the main controls / store
 * (bug-bash proposal sections 5 + 6), so this modal no longer collects them --
 * the old compress checkbox + quality slider are gone. It reads the chosen
 * quality preset from the store and, on confirm, maps it to the
 * `(compress, quality)` pair the existing submit path still expects:
 * "Original" means skip the re-encode (compress=false); every other preset
 * compresses with a representative quality value.
 *
 * (T-014 renames this to a richer read-only ReviewModal and rewires the panel;
 * this keeps the existing onConfirm contract intact in the meantime.)
 */

/** Map a quality preset to the legacy (compress, quality%) submit pair. */
export function qualityToSubmitParams(preset: QualityPreset): {
  compress: boolean;
  quality: number;
} {
  switch (preset) {
    case "original":
      return { compress: false, quality: 100 };
    case "high":
      return { compress: true, quality: 90 };
    case "fast":
      return { compress: true, quality: 70 };
    case "low":
      return { compress: true, quality: 50 };
  }
}

const QUALITY_LABELS: Record<QualityPreset, string> = {
  original: "Original (no re-encode)",
  high: "High (~CRF 18)",
  fast: "Fast (~CRF 23)",
  low: "Low (~CRF 28)",
};

interface CompressionModalProps {
  /** Start the job with the params derived from the chosen quality preset. */
  onConfirm: (compress: boolean, quality: number) => void;
  onCancel: () => void;
}

export default function CompressionModal({
  onConfirm,
  onCancel,
}: CompressionModalProps) {
  const quality = useRotoStore((s) => s.quality);
  const resolution = useRotoStore((s) => s.resolution);

  const confirm = () => {
    const { compress, quality: q } = qualityToSubmitParams(quality);
    onConfirm(compress, q);
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
        aria-label="Confirm rotoscope settings"
      >
        <div className="roto-modal__title">Send to the rotoscoping service?</div>
        <div className="roto-modal__body">
          Confirm the settings chosen in the controls below the video.
        </div>

        <dl className="roto-modal__summary">
          <div className="roto-modal__row">
            <dt>Resolution</dt>
            <dd>
              {resolution.width}x{resolution.height}
              {resolution.preset !== "custom" ? ` (${resolution.preset})` : ""}
            </dd>
          </div>
          <div className="roto-modal__row">
            <dt>Quality</dt>
            <dd>{QUALITY_LABELS[quality]}</dd>
          </div>
        </dl>

        <div className="roto-modal__actions">
          <button type="button" className="roto-modal__btn" onClick={onCancel}>
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
.roto-modal__summary {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
}
.roto-modal__row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
}
.roto-modal__row dt {
  color: var(--text-muted);
}
.roto-modal__row dd {
  margin: 0;
  color: var(--text);
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
