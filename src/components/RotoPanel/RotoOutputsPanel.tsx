import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  /** Probed source fps from meta.json, or null (older outputs / not yet
   *  recorded by the bridge -> falls back to the 30fps estimate). */
  sourceFps: number | null;
  frameCount: number;
  thumbnail: string | null;
  frames: string[];
}

/** Post-job artifacts present in an output folder, mirroring the backend
 *  `RotoOutputFiles` (src-tauri/src/commands/roto_media.rs). Each is null when
 *  the file is not on disk -- the composed video / source clip only appear once
 *  the rotoscoping bridge extracts them alongside the PNGs. */
interface RotoOutputFiles {
  zip: string | null;
  video: string | null;
  sourceClip: string | null;
}

/** Source fps assumed when converting frame_skip -> effective playback fps
 *  (matches RotoVideoPanel's ASSUMED_FPS and the proposal's 30fps estimates). */
const ASSUMED_FPS = 30;

/** Effective stop-motion fps for an output: source fps / (frame_skip + 1).
 *  `sourceFps` is the probed source rate from meta.json; it falls back to the
 *  30fps assumption when null (older outputs, or before the bridge records it).
 *  `frameSkip` falls back to the proposal default (3) when meta.json is absent. */
function effectiveFps(frameSkip: number | null, sourceFps: number | null): number {
  const fps = sourceFps ?? ASSUMED_FPS;
  return fps / ((frameSkip ?? 3) + 1);
}

export default function RotoOutputsPanel() {
  const slug = useProjectStore((s) => s.activeProject?.slug ?? null);
  // Length of the store's outputs list is the refresh trigger: jobComplete
  // bumps it when a new rotoscope finishes, so we re-enumerate from disk.
  const outputsCount = useRotoStore((s) => s.outputs.length);
  const loadSequence = useRotoStore((s) => s.loadSequence);
  const loadVideoForComparison = useRotoStore((s) => s.loadVideoForComparison);
  const requestComparison = useRotoStore((s) => s.requestComparison);

  const [outputs, setOutputs] = useState<RotoOutput[]>([]);
  // Per-output-folder artifact presence (composed video / source clip / zip),
  // keyed by the folder's absolute dir. Drives the conditional 'Open video'.
  const [files, setFiles] = useState<Record<string, RotoOutputFiles>>({});
  const [error, setError] = useState<string | null>(null);

  // Rename state: which row is in edit mode and what the user has typed.
  const [renaming, setRenaming] = useState<Record<string, boolean>>({});
  const [renameValue, setRenameValue] = useState<Record<string, string>>({});
  const [renameError, setRenameError] = useState<Record<string, string | null>>({});

  // Export UX per row: 'idle' | 'picking' (format menu open) | 'exporting'.
  const [exportState, setExportState] = useState<
    Record<string, "idle" | "picking" | "exporting">
  >({});
  // Per-row export error (shown inline, cleared when export is re-triggered).
  const [exportError, setExportError] = useState<Record<string, string | null>>({});
  // Track the unlisten fn for export://progress so we only register once.
  const exportUnlisten = useRef<(() => void) | null>(null);

  // Per-row "Copied!" feedback for the copy-name button, keyed by folder dir.
  const [copied, setCopied] = useState<Record<string, boolean>>({});
  // Which row is showing the delete-confirmation prompt, keyed by folder dir.
  const [confirmingDelete, setConfirmingDelete] = useState<Record<string, boolean>>(
    {},
  );
  // Per-row delete error (shown inline when the backend rejects the delete).
  const [deleteError, setDeleteError] = useState<Record<string, string | null>>({});

  const loadedSequenceDir = useRotoStore((s) => s.loadedSequence?.dir ?? null);
  const clearSequence = useRotoStore((s) => s.clearSequence);

  const refresh = useCallback(async () => {
    if (!slug) {
      setOutputs([]);
      setFiles({});
      return;
    }
    setError(null);
    try {
      const list = await invoke<RotoOutput[]>("list_rotoscope_outputs", { slug });
      setOutputs(list);
      // Best-effort per-folder artifact probe; a single failure must not blank
      // the list, so each is caught and folded into an empty record.
      const entries = await Promise.all(
        list.map(async (o): Promise<[string, RotoOutputFiles]> => {
          try {
            const f = await invoke<RotoOutputFiles>("get_rotoscope_output_files", {
              dir: o.dir,
            });
            return [o.dir, f];
          } catch {
            return [o.dir, { zip: null, video: null, sourceClip: null }];
          }
        }),
      );
      setFiles(Object.fromEntries(entries));
    } catch (err) {
      setError(String(err));
      setOutputs([]);
      setFiles({});
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
        fps: effectiveFps(output.frameSkip, output.sourceFps),
      });
    },
    [loadSequence],
  );

  // Compare this output against its source. Preferred source is the archived
  // source_clip.mp4 from the output folder (the exact processed clip); when that
  // is absent we fall back to o.source (the full original video from meta.json) --
  // the comparison is then against the whole source rather than the trimmed clip,
  // but it is better than nothing. The output sequence + comparison source load
  // is an atomic pair (see loadVideoForComparison's caller contract) -- it is the
  // comparison source, NOT whatever the user currently has in the setup pane. The
  // button is gated on at least one of those sources existing.
  const compareOutput = useCallback(
    (output: RotoOutput) => {
      const compareSource = files[output.dir]?.sourceClip ?? output.source;
      if (!compareSource || output.frames.length === 0) return;
      loadSequence({
        name: output.name,
        dir: output.dir,
        urls: output.frames.map((p) => convertFileSrc(p)),
        fps: effectiveFps(output.frameSkip, output.sourceFps),
      });
      loadVideoForComparison({
        path: compareSource,
        ...(output.sourceFps != null ? { fps: output.sourceFps } : {}),
      });
      requestComparison();
    },
    [files, loadSequence, loadVideoForComparison, requestComparison],
  );

  // Delete an output folder (frames + video + zip) after the row's inline
  // confirmation. On success, patch local state instead of a full refresh: drop
  // the row from `outputs` and its entry from `files`, and clear the loaded
  // sequence if the Video pane is currently playing the now-deleted folder.
  const deleteOutput = useCallback(
    async (o: RotoOutput) => {
      setDeleteError((prev) => ({ ...prev, [o.dir]: null }));
      if (!slug) {
        setDeleteError((prev) => ({ ...prev, [o.dir]: "no active project" }));
        return;
      }
      try {
        await invoke("delete_rotoscope_output", { slug, dir: o.dir });
        if (loadedSequenceDir === o.dir) clearSequence();
        setOutputs((prev) => prev.filter((item) => item.dir !== o.dir));
        setFiles((prev) => {
          if (!(o.dir in prev)) return prev;
          const next = { ...prev };
          delete next[o.dir];
          return next;
        });
        setConfirmingDelete((prev) => ({ ...prev, [o.dir]: false }));
      } catch (err) {
        setDeleteError((prev) => ({ ...prev, [o.dir]: String(err) }));
      }
    },
    [slug, loadedSequenceDir, clearSequence],
  );

  // Open a file/folder with the OS default handler. stopPropagation in the
  // button onClick keeps the row's double-click-to-play from firing too.
  const open = useCallback(async (path: string) => {
    try {
      await invoke("open_path", { path });
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const startRename = useCallback((o: RotoOutput) => {
    setRenaming((prev) => ({ ...prev, [o.dir]: true }));
    setRenameValue((prev) => ({ ...prev, [o.dir]: o.name }));
    setRenameError((prev) => ({ ...prev, [o.dir]: null }));
  }, []);

  const cancelRename = useCallback((dir: string) => {
    setRenaming((prev) => ({ ...prev, [dir]: false }));
    setRenameError((prev) => ({ ...prev, [dir]: null }));
  }, []);

  const commitRename = useCallback(
    async (o: RotoOutput) => {
      const newName = (renameValue[o.dir] ?? o.name).trim();
      if (!newName || newName === o.name) {
        cancelRename(o.dir);
        return;
      }
      setRenameError((prev) => ({ ...prev, [o.dir]: null }));
      try {
        const newDir = await invoke<string>("rename_rotoscope_output", {
          oldDir: o.dir,
          newName,
        });
        // Patch local state: swap dir/name for the renamed entry and re-key files.
        setOutputs((prev) =>
          prev.map((item) =>
            item.dir === o.dir ? { ...item, name: newName, dir: newDir } : item,
          ),
        );
        setFiles((prev) => {
          if (!(o.dir in prev)) return prev;
          const next = { ...prev };
          next[newDir] = next[o.dir]!;
          delete next[o.dir];
          return next;
        });
        setRenaming((prev) => ({ ...prev, [o.dir]: false }));
      } catch (err) {
        setRenameError((prev) => ({ ...prev, [o.dir]: String(err) }));
      }
    },
    [renameValue, cancelRename],
  );

  // Register the export://progress listener once on mount so the "Exporting…"
  // indicator stays visible while the backend is running. Progress 1.0 means
  // done; we reset the row's state to 'idle' then.
  useEffect(() => {
    let cancelled = false;
    void listen<{ progress: number }>("export://progress", (e) => {
      if (cancelled) return;
      if (e.payload.progress >= 1.0) {
        setExportState((prev) => {
          const next = { ...prev };
          for (const k of Object.keys(next)) {
            if (next[k] === "exporting") next[k] = "idle";
          }
          return next;
        });
      }
    }).then((un) => {
      if (cancelled) un();
      else exportUnlisten.current = un;
    });
    return () => {
      cancelled = true;
      exportUnlisten.current?.();
      exportUnlisten.current = null;
    };
  }, []);

  // Trigger the save dialog, then run the export. `dir` is used as the key into
  // exportState. `name` is the folder stem for the default filename.
  const startExport = useCallback(
    async (dir: string, name: string, format: string) => {
      setExportError((prev) => ({ ...prev, [dir]: null }));
      setExportState((prev) => ({ ...prev, [dir]: "exporting" }));
      try {
        const destPath = await invoke<string>("choose_roto_export_path", {
          name,
          format,
        });
        if (destPath === "cancelled") {
          setExportState((prev) => ({ ...prev, [dir]: "idle" }));
          return;
        }
        await invoke("export_roto_output", { dir, format, destPath });
        // Success: state reset via export://progress 1.0 listener, but also
        // reset here in case the event fires before this line.
        setExportState((prev) => ({ ...prev, [dir]: "idle" }));
      } catch (err) {
        setExportError((prev) => ({ ...prev, [dir]: String(err) }));
        setExportState((prev) => ({ ...prev, [dir]: "idle" }));
      }
    },
    [],
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
                {renaming[o.dir] ? (
                  <input
                    className="roto-outputs__rename-input"
                    autoFocus
                    value={renameValue[o.dir] ?? o.name}
                    onChange={(e) =>
                      setRenameValue((prev) => ({
                        ...prev,
                        [o.dir]: e.target.value,
                      }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void commitRename(o);
                      } else if (e.key === "Escape") {
                        cancelRename(o.dir);
                      }
                    }}
                    onBlur={() => void commitRename(o)}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="roto-outputs__name">{o.name}</span>
                )}
                {renameError[o.dir] ? (
                  <span
                    className="roto-outputs__rename-err"
                    title={renameError[o.dir] ?? ""}
                  >
                    {renameError[o.dir]}
                  </span>
                ) : null}
                <span className="roto-outputs__frames">
                  {o.frameCount} {o.frameCount === 1 ? "frame" : "frames"}
                </span>
                {o.source ? (
                  <span className="roto-outputs__source-line" title={o.source}>
                    {"source: "}
                    <span className="roto-outputs__source">
                      {o.source.split(/[/\\]/).pop() ?? o.source}
                    </span>
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                className="roto-outputs__rename-btn"
                title="Copy name"
                onClick={(e) => {
                  e.stopPropagation();
                  void navigator.clipboard
                    .writeText(o.name)
                    .then(() => {
                      setCopied((prev) => ({ ...prev, [o.dir]: true }));
                      setTimeout(
                        () => setCopied((prev) => ({ ...prev, [o.dir]: false })),
                        500,
                      );
                    })
                    .catch((err) => {
                      // Clipboard write can reject (permissions / no secure
                      // context). Surface it and keep the button out of the
                      // stuck 'Copied!' state.
                      console.error("copy name failed:", err);
                      setCopied((prev) => ({ ...prev, [o.dir]: false }));
                    });
                }}
              >
                {copied[o.dir] ? "Copied!" : "Copy"}
              </button>
              <button
                type="button"
                className="roto-outputs__rename-btn"
                title="Rename"
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(o);
                }}
              >
                Edit
              </button>
              {confirmingDelete[o.dir] ? (
                <div
                  className="roto-outputs__confirm"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="roto-outputs__confirm-msg">
                    Delete? This removes all frames, the video, and the zip.
                  </span>
                  <button
                    type="button"
                    className="roto-outputs__btn roto-outputs__btn--danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteOutput(o);
                    }}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    className="roto-outputs__btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmingDelete((prev) => ({ ...prev, [o.dir]: false }));
                      setDeleteError((prev) => ({ ...prev, [o.dir]: null }));
                    }}
                  >
                    Cancel
                  </button>
                  {deleteError[o.dir] ? (
                    <span
                      className="roto-outputs__export-err"
                      title={deleteError[o.dir] ?? ""}
                    >
                      !
                    </span>
                  ) : null}
                </div>
              ) : (
              <div className="roto-outputs__actions">
                <button
                  type="button"
                  className="roto-outputs__btn"
                  title="Open folder"
                  onClick={(e) => {
                    e.stopPropagation();
                    void open(o.dir);
                  }}
                >
                  Open folder
                </button>
                {files[o.dir]?.sourceClip || o.source ? (
                  <button
                    type="button"
                    className="roto-outputs__btn"
                    title={
                      files[o.dir]?.sourceClip
                        ? "Compare against the processed source clip"
                        : "Compare against the original source video"
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      compareOutput(o);
                    }}
                  >
                    Compare
                  </button>
                ) : null}
                {files[o.dir]?.video ? (
                  <button
                    type="button"
                    className="roto-outputs__btn"
                    title="Open video"
                    onClick={(e) => {
                      e.stopPropagation();
                      void open(files[o.dir].video as string);
                    }}
                  >
                    Open video
                  </button>
                ) : null}
                {exportState[o.dir] === "exporting" ? (
                  <span className="roto-outputs__exporting">Exporting...</span>
                ) : exportState[o.dir] === "picking" ? (
                  <span
                    className="roto-outputs__format-picker"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {(["GIF", "MP4", "MOV"] as const).map((fmt) => (
                      <button
                        key={fmt}
                        type="button"
                        className="roto-outputs__btn roto-outputs__btn--fmt"
                        onClick={(e) => {
                          e.stopPropagation();
                          void startExport(o.dir, o.name, fmt.toLowerCase());
                        }}
                      >
                        {fmt}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="roto-outputs__btn"
                      title="Cancel"
                      onClick={(e) => {
                        e.stopPropagation();
                        setExportState((prev) => ({
                          ...prev,
                          [o.dir]: "idle",
                        }));
                      }}
                    >
                      x
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="roto-outputs__btn"
                    title="Export as GIF, MP4, or MOV"
                    onClick={(e) => {
                      e.stopPropagation();
                      setExportError((prev) => ({ ...prev, [o.dir]: null }));
                      setExportState((prev) => ({
                        ...prev,
                        [o.dir]: "picking",
                      }));
                    }}
                  >
                    Export as...
                  </button>
                )}
                {exportError[o.dir] ? (
                  <span
                    className="roto-outputs__export-err"
                    title={exportError[o.dir] ?? ""}
                  >
                    !
                  </span>
                ) : null}
                <button
                  type="button"
                  className="roto-outputs__btn roto-outputs__btn--danger"
                  title="Delete output"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteError((prev) => ({ ...prev, [o.dir]: null }));
                    setConfirmingDelete((prev) => ({ ...prev, [o.dir]: true }));
                  }}
                >
                  Delete
                </button>
              </div>
              )}
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
  flex: 1 1 auto;
}
.roto-outputs__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}
.roto-outputs__btn {
  flex: none;
  padding: 3px 8px;
  font: inherit;
  font-size: 10px;
  color: var(--text-muted);
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: 3px;
  cursor: pointer;
}
.roto-outputs__btn:hover {
  color: var(--text);
  border-color: var(--text-faint);
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
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.roto-outputs__source-line {
  /* Own line below the frame count so the basename isn't eaten by the
     frames-row ellipsis; still truncates on its own if the path is long. */
  color: var(--text-faint);
  font-size: 10px;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.roto-outputs__source {
  color: var(--text-muted);
}
.roto-outputs__btn--danger {
  color: #fca5a5;
}
.roto-outputs__btn--danger:hover {
  color: #fff;
  background: #b91c1c;
  border-color: #b91c1c;
}
.roto-outputs__confirm {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}
.roto-outputs__confirm-msg {
  font-size: 10px;
  color: var(--text-muted);
}
.roto-outputs__format-picker {
  display: flex;
  align-items: center;
  gap: 4px;
}
.roto-outputs__btn--fmt {
  color: var(--text);
  border-color: var(--text-faint);
}
.roto-outputs__btn--fmt:hover {
  background: var(--surface-alt);
}
.roto-outputs__exporting {
  font-size: 10px;
  color: var(--text-faint);
  font-style: italic;
}
.roto-outputs__export-err {
  font-size: 10px;
  color: #fca5a5;
  font-weight: bold;
  cursor: default;
}
.roto-outputs__rename-btn {
  flex: none;
  padding: 3px 8px;
  font: inherit;
  font-size: 10px;
  color: var(--text-muted);
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: 3px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.1s;
}
.roto-outputs__row:hover .roto-outputs__rename-btn {
  opacity: 1;
}
.roto-outputs__rename-btn:hover {
  color: var(--text);
  border-color: var(--text-faint);
}
.roto-outputs__rename-input {
  font: inherit;
  font-size: 12px;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--text-faint);
  border-radius: 3px;
  padding: 1px 4px;
  min-width: 0;
  width: 100%;
  outline: none;
}
.roto-outputs__rename-input:focus {
  border-color: var(--text-muted);
}
.roto-outputs__rename-err {
  font-size: 10px;
  color: #fca5a5;
  word-break: break-word;
  line-height: 1.3;
}
`;
