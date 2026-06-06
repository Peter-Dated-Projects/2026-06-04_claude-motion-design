import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useProjectStore } from "../../store/projectStore";

/**
 * The rotoscoping stage's top-right "Project Assets" pane.
 *
 * Scoped subset (T-005): lists the active project's IMAGE assets via the
 * existing `list_assets` command -- the same data the Code panel's AssetsView
 * shows -- as a thumbnail grid. Images are display-only here; they are not a
 * valid rotoscope source (the source must be a video), so they have no
 * double-click action, matching the proposal ("Images are listed but not
 * loadable as a roto source").
 *
 * Source VIDEOS are intentionally NOT listed: there is no backend surface that
 * enumerates project videos with absolute paths yet (`list_assets` returns
 * images only and carries no path; source videos are referenced in place and
 * never copied into the project). That wiring -- plus the double-click ->
 * `rotoStore.loadVideo` flow -- is deferred to T-006 (see TODO below), which
 * depends on this ticket and edits this file afterward.
 *
 * Pure consumer: reads the active slug from the project store and calls one
 * existing command. No new shared wiring.
 */

/** One image in the project's assets/, bytes inlined as a base64 data URI.
 *  Mirrors projects.rs::AssetFile (the `list_assets` return shape). */
interface AssetFile {
  name: string;
  dataUri: string;
}

export default function RotoAssetsPanel() {
  const slug = useProjectStore((s) => s.activeProject?.slug ?? null);

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

  // TODO(T-006): list source videos here (needs a backend command that
  // enumerates project videos with absolute paths) and make a video row's
  // double-click call rotoStore.loadVideo({ path }) to load it into the left
  // Video Preview pane. Out of this ticket's scope (no backend surface yet).

  return (
    <div className="roto-assets">
      <style>{STYLES}</style>
      <div className="roto-assets__label">Project Assets</div>

      {error ? <div className="roto-assets__error">{error}</div> : null}

      {!slug ? (
        <div className="roto-assets__hint">No project open.</div>
      ) : loading && assets.length === 0 ? (
        <div className="roto-assets__hint">Loading...</div>
      ) : assets.length === 0 ? (
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
`;
