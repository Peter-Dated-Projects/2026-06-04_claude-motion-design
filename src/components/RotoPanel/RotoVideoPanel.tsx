import { useRotoStore } from "../../store/rotoStore";

/**
 * STUB -- the rotoscoping stage's left "Video" pane.
 *
 * Scaffolded by T-003 (workspace shell). The real implementation (the video
 * player + scrubber, "Set Start Frame", the point-placement overlay, the frame-
 * skip selector with live output-frame estimate, the Generate/compression flow,
 * and the processing view) is ticket T-004; it replaces this body and reads/
 * writes the same `rotoStore`. Keep it a pure store consumer -- the Tauri
 * `invoke`/`listen` wiring lives at the app boundary, not in the panel.
 */
export default function RotoVideoPanel() {
  const video = useRotoStore((s) => s.video);
  const phase = useRotoStore((s) => s.phase);

  return (
    <div className="roto-stub roto-stub--video">
      <style>{STUB_STYLES}</style>
      <div className="roto-stub__label">Video</div>
      {video ? (
        <div className="roto-stub__hint">
          Loaded: {video.path}
          <br />
          (phase: {phase}) -- player + point overlay land in T-004.
        </div>
      ) : (
        <div className="roto-stub__hint">
          Double-click a video from the panel on the right.
        </div>
      )}
    </div>
  );
}

// Stub styling, self-contained per panel (no CSS file is in this ticket's scope)
// so each panel ticket can evolve its own pane independently. Tracks the app
// theme tokens defined in App.css.
const STUB_STYLES = `
.roto-stub {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: auto;
  background: var(--surface-alt);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.roto-stub__label {
  position: sticky;
  top: 0;
  padding: 6px 10px;
  color: var(--text-muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  border-bottom: 1px solid var(--border-soft);
  background: var(--surface-alt);
}
.roto-stub__hint {
  padding: 16px 12px;
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.6;
  text-align: center;
}
`;
