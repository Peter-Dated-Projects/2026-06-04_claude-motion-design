import { useRotoStore } from "../../store/rotoStore";

/**
 * STUB -- the rotoscoping stage's bottom-right "Outputs" pane.
 *
 * Scaffolded by T-003 (workspace shell). The real implementation (lists this
 * project's completed `rotoscope_<name>/` jobs; double-clicking one loads its
 * PNG sequence into the Video pane as a looping stop-motion playback) is ticket
 * T-005; it replaces this body and reads from the same `rotoStore`. Keep it a
 * pure store consumer.
 */
export default function RotoOutputsPanel() {
  const outputs = useRotoStore((s) => s.outputs);

  return (
    <div className="roto-stub roto-stub--outputs">
      <style>{STUB_STYLES}</style>
      <div className="roto-stub__label">Rotoscope Outputs</div>
      {outputs.length === 0 ? (
        <div className="roto-stub__hint">
          Completed rotoscope jobs appear here -- list lands in T-005.
        </div>
      ) : (
        <ul className="roto-stub__list">
          {outputs.map((o) => (
            <li key={o.dir} className="roto-stub__row" title={o.dir}>
              {o.name} ({o.frameCount})
            </li>
          ))}
        </ul>
      )}
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
.roto-stub__list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
}
.roto-stub__row {
  padding: 4px 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
`;
