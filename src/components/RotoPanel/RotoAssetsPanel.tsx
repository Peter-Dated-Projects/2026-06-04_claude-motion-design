import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useProjectStore } from "../../store/projectStore";
import { useRotoStore } from "../../store/rotoStore";

/**
 * The rotoscoping stage's top-right "Project Assets" pane.
 *
 * Lists the active project's IMAGE assets via the existing `list_assets`
 * command -- the same data the Code panel's AssetsView shows -- as a thumbnail
 * grid. Images are display-only here; they are not a valid rotoscope source
 * (the source must be a video), so they have no double-click action, matching
 * the proposal ("Images are listed but not loadable as a roto source").
 *
 * Source VIDEOS enter via the "Load video..." button (T-006): a native file
 * picker (plugin-dialog `open`, video filters) whose chosen absolute path is
 * handed to `rotoStore.loadVideo` -- the source is referenced in place, never
 * copied into the project (per the proposal), so there is no project-video
 * registry to enumerate here.
 */

/** One image in the project's assets/, bytes inlined as a base64 data URI.
 *  Mirrors projects.rs::AssetFile (the `list_assets` return shape). */
interface AssetFile {
  name: string;
  dataUri: string;
}

/** Common source-video extensions offered in the file picker. */
const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "webm", "mkv", "avi"];

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function RotoAssetsPanel() {
  const slug = useProjectStore((s) => s.activeProject?.slug ?? null);
  const loadVideo = useRotoStore((s) => s.loadVideo);
  const video = useRotoStore((s) => s.video);
  const resetRoto = useRotoStore((s) => s.reset);

  const [assets, setAssets] = useState<AssetFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!slug) {
      setAssets([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await invoke<AssetFile[]>("list_assets", { slug });
      setAssets(list);
    } catch (err) {
      setError(String(err));
      setAssets([]);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Pick a source video from disk and load it into the left preview pane. The
  // path is referenced in place (never copied), matching the proposal.
  const pickVideo = useCallback(async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
    });
    if (typeof selected === "string") {
      loadVideo({ path: selected });
    }
  }, [loadVideo]);

  return (
    <div className="roto-assets">
      <style>{STYLES}</style>
      <div className="roto-assets__label">
        Project Assets
        <button
          type="button"
          className="roto-assets__load"
          onClick={() => void pickVideo()}
        >
          Load video...
        </button>
      </div>

      {error ? <div className="roto-assets__error">{error}</div> : null}

      {video ? (
        <div className="roto-assets__video-row">
          <div className="roto-assets__video-info">
            <span className="roto-assets__video-badge">VIDEO</span>
            <span className="roto-assets__video-name" title={video.path}>
              {video.path.split("/").pop() ?? video.path}
            </span>
            {video.durationSeconds !== undefined ? (
              <span className="roto-assets__video-dur">
                {formatDuration(video.durationSeconds)}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="roto-assets__video-clear"
            onClick={resetRoto}
          >
            Clear
          </button>
        </div>
      ) : null}

      {!slug ? (
        <div className="roto-assets__hint">No project open.</div>
      ) : loading && assets.length === 0 ? (
        <div className="roto-assets__hint">Loading...</div>
      ) : assets.length === 0 && !video ? (
        <div className="roto-assets__hint">
          No image assets yet.
          <br />
          Add images from the Code panel's Assets view.
        </div>
      ) : (
        <ul className="roto-assets__grid">
          {assets.map((asset) => (
            <li
              key={asset.name}
              className="roto-assets__item"
              title={`${asset.name} (image -- not a rotoscope source)`}
            >
              <div className="roto-assets__thumb">
                <img
                  src={asset.dataUri}
                  alt={asset.name}
                  loading="lazy"
                  draggable={false}
                />
              </div>
              <span className="roto-assets__name">{asset.name}</span>
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
.roto-assets {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--surface-alt);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.roto-assets__label {
  display: flex;
  align-items: center;
  justify-content: space-between;
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
.roto-assets__load {
  padding: 3px 10px;
  font-size: 10px;
  font-family: inherit;
  font-weight: 600;
  text-transform: none;
  letter-spacing: 0;
  color: #fff;
  background: var(--accent, #6ea8fe);
  border: none;
  border-radius: 4px;
  cursor: pointer;
}
.roto-assets__error {
  padding: 8px 10px;
  color: #fca5a5;
  font-size: 11px;
  line-height: 1.4;
  word-break: break-word;
}
.roto-assets__hint {
  padding: 16px 12px;
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.6;
  text-align: center;
}
.roto-assets__grid {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  list-style: none;
  margin: 0;
  padding: 10px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  gap: 8px;
  align-content: start;
}
.roto-assets__item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.roto-assets__thumb {
  width: 100%;
  aspect-ratio: 1 / 1;
  border-radius: 3px;
  overflow: hidden;
  background: var(--surface);
  border: 1px solid var(--border-soft);
}
.roto-assets__thumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.roto-assets__name {
  color: var(--text-muted);
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.roto-assets__video-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--surface);
  flex-shrink: 0;
}
.roto-assets__video-info {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.roto-assets__video-badge {
  flex-shrink: 0;
  padding: 1px 5px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: #fff;
  background: #7c5cfc;
  border-radius: 3px;
}
.roto-assets__video-name {
  font-size: 11px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.roto-assets__video-dur {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-muted);
}
.roto-assets__video-clear {
  flex-shrink: 0;
  padding: 2px 8px;
  font-size: 10px;
  font-family: inherit;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border-soft);
  border-radius: 3px;
  cursor: pointer;
}
.roto-assets__video-clear:hover {
  color: var(--text);
  border-color: var(--text-muted);
}
`;
