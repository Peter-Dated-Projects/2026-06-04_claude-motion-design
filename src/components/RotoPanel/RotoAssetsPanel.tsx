import { useRotoStore } from "../../store/rotoStore";

/**
 * STUB -- the rotoscoping stage's top-right "Assets" pane.
 *
 * Scaffolded by T-003 (workspace shell). The real implementation (lists the
 * project's videos/images; double-clicking a video calls `rotoStore.loadVideo`
 * to load it into the Video pane on the left) is ticket T-005; it replaces this
 * body and reads/writes the same `rotoStore`. Keep it a pure store consumer.
 */
export default function RotoAssetsPanel() {
  const video = useRotoStore((s) => s.video);

  return (
    <div className="roto-stub roto-stub--assets">
      <style>{STUB_STYLES}</style>
      <div className="roto-stub__label">Project Assets</div>
      <div className="roto-stub__hint">
        Project videos + images list -- lands in T-005.
        {video ? <br /> : null}
        {video ? `Loaded: ${video.path}` : null}
      </div>
    </div>
  );
}

// Stub styling, self-contained per panel (no CSS file is in this ticket's scope).
// Tracks the app theme tokens defined in App.css.
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
