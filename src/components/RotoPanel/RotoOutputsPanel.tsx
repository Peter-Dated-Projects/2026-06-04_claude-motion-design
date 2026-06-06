import { useCallback, useEffect, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { useRotoStore } from "../../store/rotoStore";
import { useProjectStore } from "../../store/projectStore";

/**
 * The rotoscoping stage's bottom-right "Rotoscope Outputs" pane.
 *
 * Backend-driven (T-006): enumerates the active project's completed rotoscope
 * jobs via `list_rotoscope_outputs` -- one row per `assets/rotoscope_<source>/`
 * folder, each carrying its ordered PNG paths + a thumbnail. A row renders the
 * first PNG (via the Tauri asset protocol / convertFileSrc) + the folder label
 * + frame count. Double-clicking a row loads that output's PNG sequence into the
 * left Video pane as looping stop-motion at the effective output fps
 * (rotoStore.loadSequence).
 *
 * Refreshes on project switch and whenever `rotoStore.outputs` changes length --
 * `rotoStore.jobComplete` pushes a fresh result there after a successful
 * `rotoscope_video`, so a just-finished job appears without a manual reload.
 */

/** One completed output, mirroring the backend `RotoOutput`
 *  (src-tauri/src/commands/roto_media.rs). camelCase across the boundary. */
interface RotoOutput {
  name: string;
  dir: string;
  source: string | null;
  frameSkip: number | null;
  frameCount: number;
  thumbnail: string | null;
  frames: string[];
}

/** Source fps assumed when converting frame_skip -> effective playback fps
 *  (matches RotoVideoPanel's ASSUMED_FPS and the proposal's 30fps estimates). */
const ASSUMED_FPS = 30;

/** Effective stop-motion fps for an output: source fps / (frame_skip + 1).
 *  frame_skip falls back to the proposal default (3) when meta.json is absent. */
function effectiveFps(frameSkip: number | null): number {
  const skip = frameSkip ?? 3;
  return ASSUMED_FPS / (skip + 1);
}

export default function RotoOutputsPanel() {
  const slug = useProjectStore((s) => s.activeProject?.slug ?? null);
  // Length of the store's outputs list is the refresh trigger: jobComplete
  // bumps it when a new rotoscope finishes, so we re-enumerate from disk.
  const outputsCount = useRotoStore((s) => s.outputs.length);
  const loadSequence = useRotoStore((s) => s.loadSequence);

  const [outputs, setOutputs] = useState<RotoOutput[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!slug) {
      setOutputs([]);
      return;
    }
    setError(null);
    try {
      const list = await invoke<RotoOutput[]>("list_rotoscope_outputs", { slug });
      setOutputs(list);
    } catch (err) {
      setError(String(err));
      setOutputs([]);
    }
  }, [slug]);

  useEffect(() => {
    void refresh();
  }, [refresh, outputsCount]);

  const playOutput = useCallback(
    (output: RotoOutput) => {
      if (output.frames.length === 0) return;
      loadSequence({
        name: output.name,
        dir: output.dir,
        urls: output.frames.map((p) => convertFileSrc(p)),
        fps: effectiveFps(output.frameSkip),
      });
    },
    [loadSequence],
  );

  return (
    <div className="roto-outputs">
      <style>{STYLES}</style>
      <div className="roto-outputs__label">
        Rotoscope Outputs
        {outputs.length > 0 ? (
          <span className="roto-outputs__count">{outputs.length}</span>
        ) : null}
      </div>

      {error ? <div className="roto-outputs__error">{error}</div> : null}

      {outputs.length === 0 ? (
        <div className="roto-outputs__hint">
          Completed rotoscope jobs appear here.
        </div>
      ) : (
        <ul className="roto-outputs__list">
          {outputs.map((o) => (
            <li
              key={o.dir}
              className="roto-outputs__row"
              title={`${o.dir}\nDouble-click to play`}
              onDoubleClick={() => playOutput(o)}
            >
              <div className="roto-outputs__thumb">
                {o.thumbnail ? (
                  <img
                    src={convertFileSrc(o.thumbnail)}
                    alt={o.name}
                    loading="lazy"
                    draggable={false}
                  />
                ) : null}
              </div>
              <div className="roto-outputs__meta">
                <span className="roto-outputs__name">{o.name}</span>
                <span className="roto-outputs__frames">
                  {o.frameCount} {o.frameCount === 1 ? "frame" : "frames"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Scoped styles -- no CSS file is in this ticket's scope, so the pane's look
// lives here in a one-time <style> block (same convention as the T-003 stubs
// and the IG panels). Colors come from the app theme tokens defined in App.css.
const STYLES = `
.roto-outputs {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--surface-alt);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.roto-outputs__label {
  display: flex;
  align-items: center;
  gap: 8px;
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
.roto-outputs__count {
  color: var(--text-faint);
  text-transform: none;
  letter-spacing: 0;
}
.roto-outputs__error {
  padding: 8px 10px;
  color: #fca5a5;
  font-size: 11px;
  line-height: 1.4;
  word-break: break-word;
}
.roto-outputs__hint {
  padding: 16px 12px;
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.6;
  text-align: center;
}
.roto-outputs__list {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  list-style: none;
  margin: 0;
  padding: 4px 0;
}
.roto-outputs__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  cursor: pointer;
  user-select: none;
}
.roto-outputs__row:hover {
  background: var(--surface);
}
.roto-outputs__thumb {
  flex: none;
  width: 40px;
  height: 40px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--surface);
  border: 1px solid var(--border-soft);
  /* Checkerboard so transparent rotoscope PNGs read as cut-outs, not blank. */
  background-image:
    linear-gradient(45deg, var(--border-soft) 25%, transparent 25%),
    linear-gradient(-45deg, var(--border-soft) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--border-soft) 75%),
    linear-gradient(-45deg, transparent 75%, var(--border-soft) 75%);
  background-size: 10px 10px;
  background-position: 0 0, 0 5px, 5px -5px, -5px 0;
}
.roto-outputs__thumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.roto-outputs__meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.roto-outputs__name {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.roto-outputs__frames {
  color: var(--text-faint);
  font-size: 10px;
}
`;
