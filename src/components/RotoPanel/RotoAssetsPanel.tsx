import { useCallback, useEffect, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useProjectStore } from "../../store/projectStore";
import { useRotoStore } from "../../store/rotoStore";
import { TrashIcon } from "../icons";
import RotoContextMenu from "./RotoContextMenu";

/**
 * The rotoscoping stage's top-right "Project Assets" pane.
 *
 * Source VIDEOS are persisted per project (T-006 / bug-bash 3): the "Load
 * video..." button registers the chosen path with the project via
 * `add_project_video` (idempotent) and then loads it into the left pane through
 * `rotoStore.loadVideo`. The persisted list is read with `list_project_videos`
 * and survives restarts -- a video stays until the user explicitly removes it
 * (per-row remove -> `remove_project_video`). The video file is referenced in
 * place, never copied into the project. The "Clear" button (only on the
 * currently-loaded row) calls `rotoStore.reset()` -- a session-only unload that
 * leaves the video in the persisted list.
 *
 * IMAGE assets come from `list_assets` (same data as the Code panel's
 * AssetsView). Images are display-only here; they are not a valid rotoscope
 * source (the source must be a video), so they have no load action.
 *
 * A bottom toolbar filters (by filename, case-insensitive), sorts (name asc/desc),
 * and switches between a compact list and a thumbnail grid. View mode and grid
 * zoom persist in localStorage; filter/sort are pure in-render transforms over
 * the raw video + image lists (no backend round-trip).
 */

/** One image in the project's assets/, bytes inlined as a base64 data URI.
 *  Mirrors projects.rs::AssetFile (the `list_assets` return shape). */
interface AssetFile {
  name: string;
  dataUri: string;
}

/** One persisted source video. Mirrors projects.rs::ProjectVideo
 *  (the `list_project_videos` return shape). camelCase across the boundary. */
interface ProjectVideo {
  path: string;
  addedAt: string;
}

/** Common source-video extensions offered in the file picker. */
const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "webm", "mkv", "avi"];

/** localStorage keys + grid-zoom bounds for the toolbar (proposal section 2). */
const VIEW_KEY = "claude-motion:rotoAssetsView";
const ZOOM_KEY = "claude-motion:rotoAssetsZoom";
const ZOOM_MIN = 48;
const ZOOM_MAX = 120;
const ZOOM_STEP = 16;
const ZOOM_DEFAULT = 72;

/** Per-project key for the last-loaded source video, so it can be restored on
 *  the next mount (proposal item 3). Written on load, cleared on reset. */
function loadedVideoKey(slug: string): string {
  return `roto:loadedVideo:${slug}`;
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

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
  const [projectVideos, setProjectVideos] = useState<ProjectVideo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Visual single-click selection (item 2) -- purely cosmetic, no action.
  const [selectedVideoPath, setSelectedVideoPath] = useState<string | null>(
    null,
  );
  // Open right-click context menu (item 8): captured cursor point + target row.
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(
    null,
  );

  // Toolbar state -- all local; filter/sort are pure in-render transforms.
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"name-asc" | "name-desc">("name-asc");
  const [view, setView] = useState<"list" | "grid">(() =>
    localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list",
  );
  const [zoom, setZoom] = useState<number>(() => {
    const raw = Number(localStorage.getItem(ZOOM_KEY));
    return Number.isFinite(raw) && raw > 0
      ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, raw))
      : ZOOM_DEFAULT;
  });

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);
  useEffect(() => {
    localStorage.setItem(ZOOM_KEY, String(zoom));
  }, [zoom]);

  // Load a video into the left pane AND remember it as this project's
  // last-loaded source (item 3). Every load path routes through here so the
  // persisted key never drifts from what is actually loaded.
  const loadVideoPath = useCallback(
    (path: string) => {
      if (slug) localStorage.setItem(loadedVideoKey(slug), path);
      loadVideo({ path });
    },
    [slug, loadVideo],
  );

  // Session-only unload + forget the persisted choice, so the next mount does
  // not restore it. Mirrors loadVideoPath's key write (item 3).
  const clearLoadedVideo = useCallback(() => {
    if (slug) localStorage.removeItem(loadedVideoKey(slug));
    resetRoto();
  }, [slug, resetRoto]);

  const refresh = useCallback(async () => {
    if (!slug) {
      setAssets([]);
      setProjectVideos([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [imgs, vids] = await Promise.all([
        invoke<AssetFile[]>("list_assets", { slug }),
        invoke<ProjectVideo[]>("list_project_videos", { slug }),
      ]);
      setAssets(imgs);
      setProjectVideos(vids);
      // Restore the last-loaded video (item 3): only if it is still a
      // registered video and isn't already the loaded source -- reloading the
      // same path would needlessly reset the in-progress setup.
      const stored = localStorage.getItem(loadedVideoKey(slug));
      if (
        stored &&
        vids.some((v) => v.path === stored) &&
        useRotoStore.getState().video?.path !== stored
      ) {
        loadVideoPath(stored);
      }
    } catch (err) {
      setError(String(err));
      setAssets([]);
      setProjectVideos([]);
    } finally {
      setLoading(false);
    }
  }, [slug, loadVideoPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Pick a source video from disk, register it with the project (persisted, so
  // it survives restarts), and load it into the left preview pane. Adding and
  // using are a single action; the path is referenced in place (never copied).
  const pickVideo = useCallback(async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
    });
    if (typeof selected !== "string") return;
    if (slug) {
      try {
        await invoke("add_project_video", { slug, path: selected });
      } catch (err) {
        setError(String(err));
      }
    }
    loadVideoPath(selected);
    void refresh();
  }, [loadVideoPath, slug, refresh]);

  // Remove a registered video from the project. If it is the currently-loaded
  // source, also reset the session so the left pane does not keep playing it.
  const removeVideo = useCallback(
    async (path: string) => {
      if (!slug) return;
      try {
        await invoke("remove_project_video", { slug, path });
        if (video?.path === path) clearLoadedVideo();
        if (selectedVideoPath === path) setSelectedVideoPath(null);
        void refresh();
      } catch (err) {
        setError(String(err));
      }
    },
    [slug, video, clearLoadedVideo, selectedVideoPath, refresh],
  );

  // Ctrl +/- adjust grid column min-width while the panel is focused; no effect
  // in list view. Clamped to [ZOOM_MIN, ZOOM_MAX] in ZOOM_STEP increments.
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (view !== "grid" || !e.ctrlKey) return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP));
      } else if (e.key === "-") {
        e.preventDefault();
        setZoom((z) => Math.max(ZOOM_MIN, z - ZOOM_STEP));
      }
    },
    [view],
  );

  // --- pure in-render filter + sort ------------------------------------------
  const q = search.trim().toLowerCase();
  const dir = sort === "name-asc" ? 1 : -1;
  const filteredVideos = projectVideos
    .filter((v) => basename(v.path).toLowerCase().includes(q))
    .sort((a, b) => dir * basename(a.path).localeCompare(basename(b.path)));
  const filteredImages = assets
    .filter((a) => a.name.toLowerCase().includes(q))
    .sort((a, b) => dir * a.name.localeCompare(b.name));

  // A loaded source video that isn't in the persisted list (e.g. loaded by some
  // other flow) still needs a Clear affordance, shown as a standalone row.
  const loadedInList =
    video != null && projectVideos.some((v) => v.path === video.path);

  const isEmpty = filteredVideos.length === 0 && filteredImages.length === 0;

  // Row interactions shared by the list and grid renderers.
  // Single-click selects (visual only, item 2); double-click loads unless it is
  // already the loaded source (item 1); right-click opens the context menu and
  // also selects the row it targets (item 8).
  const selectRow = useCallback((path: string) => setSelectedVideoPath(path), []);
  const loadOnDoubleClick = useCallback(
    (path: string) => {
      if (video?.path !== path) loadVideoPath(path);
    },
    [video, loadVideoPath],
  );
  const openMenu = useCallback(
    (e: ReactMouseEvent, path: string) => {
      e.preventDefault();
      setSelectedVideoPath(path);
      setMenu({ x: e.clientX, y: e.clientY, path });
    },
    [],
  );

  return (
    <div className="roto-assets" tabIndex={0} onKeyDown={onKeyDown}>
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

      <div
        className="roto-assets__content"
        // Clicking empty list area (not a row) clears the visual selection.
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelectedVideoPath(null);
        }}
      >
        {video && !loadedInList ? (
          <div className="roto-assets__video-row roto-assets__video-row--loaded">
            <div className="roto-assets__video-info">
              <span className="roto-assets__video-badge">VIDEO</span>
              <span className="roto-assets__video-name" title={video.path}>
                {basename(video.path)}
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
              onClick={clearLoadedVideo}
            >
              Clear
            </button>
          </div>
        ) : null}

        {!slug ? (
          <div className="roto-assets__hint">No project open.</div>
        ) : loading && isEmpty ? (
          <div className="roto-assets__hint">Loading...</div>
        ) : isEmpty && !video ? (
          <div className="roto-assets__hint">
            {search
              ? "No assets match the filter."
              : "No videos or image assets yet."}
            {!search ? (
              <>
                <br />
                Add a video above, or images from the Code panel's Assets view.
              </>
            ) : null}
          </div>
        ) : (
          <>
            {filteredVideos.length > 0 ? (
              view === "grid" ? (
                <ul
                  className="roto-assets__grid"
                  style={{
                    gridTemplateColumns: `repeat(auto-fill, minmax(${zoom}px, 1fr))`,
                  }}
                >
                  {filteredVideos.map((v) => {
                    const loaded = video?.path === v.path;
                    const selected = selectedVideoPath === v.path;
                    return (
                      <li
                        key={v.path}
                        className={
                          "roto-assets__vcard" +
                          (loaded ? " roto-assets__vcard--loaded" : "") +
                          (selected ? " roto-assets__vcard--selected" : "")
                        }
                        title={v.path}
                        onClick={() => selectRow(v.path)}
                        onDoubleClick={() => loadOnDoubleClick(v.path)}
                        onContextMenu={(e) => openMenu(e, v.path)}
                      >
                        <div className="roto-assets__vthumb">
                          <span className="roto-assets__video-badge">VIDEO</span>
                          <button
                            type="button"
                            className="roto-assets__vthumb-trash"
                            title="Remove from project"
                            onClick={(e) => {
                              e.stopPropagation();
                              void removeVideo(v.path);
                            }}
                          >
                            <TrashIcon size={13} />
                          </button>
                          <div className="roto-assets__vthumb-overlay">
                            {loaded ? (
                              <button
                                type="button"
                                className="roto-assets__video-clear"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  clearLoadedVideo();
                                }}
                              >
                                Clear
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="roto-assets__btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  loadVideoPath(v.path);
                                }}
                              >
                                Load
                              </button>
                            )}
                          </div>
                        </div>
                        <span className="roto-assets__name">
                          {basename(v.path)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <ul className="roto-assets__videos">
                  {filteredVideos.map((v) => {
                    const loaded = video?.path === v.path;
                    const selected = selectedVideoPath === v.path;
                    return (
                      <li
                        key={v.path}
                        className={
                          "roto-assets__video-row" +
                          (loaded ? " roto-assets__video-row--loaded" : "") +
                          (selected ? " roto-assets__video-row--selected" : "")
                        }
                        onClick={() => selectRow(v.path)}
                        onDoubleClick={() => loadOnDoubleClick(v.path)}
                        onContextMenu={(e) => openMenu(e, v.path)}
                      >
                        <div className="roto-assets__video-info">
                          <span className="roto-assets__video-badge">VIDEO</span>
                          <span
                            className="roto-assets__video-name"
                            title={v.path}
                          >
                            {basename(v.path)}
                          </span>
                          {loaded && video?.durationSeconds !== undefined ? (
                            <span className="roto-assets__video-dur">
                              {formatDuration(video.durationSeconds)}
                            </span>
                          ) : null}
                        </div>
                        <div className="roto-assets__video-actions">
                          {loaded ? (
                            <button
                              type="button"
                              className="roto-assets__video-clear"
                              onClick={(e) => {
                                e.stopPropagation();
                                clearLoadedVideo();
                              }}
                            >
                              Clear
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="roto-assets__btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                loadVideoPath(v.path);
                              }}
                            >
                              Load
                            </button>
                          )}
                          <button
                            type="button"
                            className="roto-assets__btn roto-assets__remove"
                            title="Remove from project"
                            onClick={(e) => {
                              e.stopPropagation();
                              void removeVideo(v.path);
                            }}
                          >
                            <TrashIcon size={13} />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )
            ) : null}

            {filteredImages.length > 0 ? (
              view === "grid" ? (
                <ul
                  className="roto-assets__grid"
                  style={{
                    gridTemplateColumns: `repeat(auto-fill, minmax(${zoom}px, 1fr))`,
                  }}
                >
                  {filteredImages.map((asset) => (
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
              ) : (
                <ul className="roto-assets__imglist">
                  {filteredImages.map((asset) => (
                    <li
                      key={asset.name}
                      className="roto-assets__imgrow"
                      title={`${asset.name} (image -- not a rotoscope source)`}
                    >
                      <div className="roto-assets__imgrow-thumb">
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
              )
            ) : null}
          </>
        )}
      </div>

      <div className="roto-assets__toolbar">
        <div className="roto-assets__toolbar-side roto-assets__toolbar-side--main">
          <button
            type="button"
            className="roto-assets__tool-btn"
            title="Sort by name"
            onClick={() =>
              setSort((s) => (s === "name-asc" ? "name-desc" : "name-asc"))
            }
          >
            {sort === "name-asc" ? "Sort A-Z" : "Sort Z-A"}
          </button>
          <div className="roto-assets__search">
            <input
              className="roto-assets__search-input"
              type="text"
              value={search}
              placeholder="filter by name"
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setSearch("");
              }}
            />
            {search ? (
              <button
                type="button"
                className="roto-assets__search-clear"
                title="Clear filter"
                onClick={() => setSearch("")}
              >
                x
              </button>
            ) : null}
          </div>
        </div>
        <div className="roto-assets__toolbar-side">
          <button
            type="button"
            className={
              "roto-assets__tool-btn" +
              (view === "list" ? " roto-assets__tool-btn--active" : "")
            }
            title="List view"
            onClick={() => setView("list")}
          >
            List
          </button>
          <button
            type="button"
            className={
              "roto-assets__tool-btn" +
              (view === "grid" ? " roto-assets__tool-btn--active" : "")
            }
            title="Grid view (Ctrl +/- to zoom)"
            onClick={() => setView("grid")}
          >
            Grid
          </button>
        </div>
      </div>

      {menu
        ? (() => {
            const loaded = video?.path === menu.path;
            return (
              <RotoContextMenu
                x={menu.x}
                y={menu.y}
                onClose={() => setMenu(null)}
                items={[
                  loaded
                    ? {
                        type: "action",
                        label: "Clear",
                        onClick: clearLoadedVideo,
                      }
                    : {
                        type: "action",
                        label: "Load",
                        onClick: () => loadVideoPath(menu.path),
                      },
                  { type: "separator" },
                  {
                    type: "action",
                    label: "Remove",
                    danger: true,
                    icon: <TrashIcon />,
                    onClick: () => void removeVideo(menu.path),
                  },
                ]}
              />
            );
          })()
        : null}
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
  outline: none;
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
.roto-assets__content {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
.roto-assets__hint {
  padding: 16px 12px;
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.6;
  text-align: center;
}
.roto-assets__videos {
  list-style: none;
  margin: 0;
  padding: 0;
}
.roto-assets__grid {
  margin: 0;
  padding: 10px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  gap: 8px;
  align-content: start;
  list-style: none;
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
/* Video cards in grid view (item 5): a square dark tile with the VIDEO badge
   centered; the filename sits below. Trash (top-right) and a Load/Clear bar
   (bottom) fade in on hover. */
.roto-assets__vcard {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  cursor: pointer;
}
.roto-assets__vthumb {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  border-radius: 3px;
  overflow: hidden;
  background: var(--surface);
  border: 1px solid var(--border-soft);
  display: flex;
  align-items: center;
  justify-content: center;
}
.roto-assets__vcard--loaded .roto-assets__vthumb {
  border-color: var(--text-faint);
}
.roto-assets__vcard--selected .roto-assets__vthumb {
  box-shadow: inset 0 0 0 2px var(--accent, #6ea8fe);
}
.roto-assets__vthumb-trash {
  position: absolute;
  top: 4px;
  right: 4px;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 3px;
  color: #fca5a5;
  background: rgba(0, 0, 0, 0.5);
  border: none;
  border-radius: 3px;
  cursor: pointer;
}
.roto-assets__vthumb-trash:hover {
  color: #fff;
  background: #b91c1c;
}
.roto-assets__vthumb:hover .roto-assets__vthumb-trash {
  display: inline-flex;
}
.roto-assets__vthumb-overlay {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 5px;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.65));
}
.roto-assets__vthumb:hover .roto-assets__vthumb-overlay {
  display: flex;
}
.roto-assets__imglist {
  list-style: none;
  margin: 0;
  padding: 4px 0;
}
.roto-assets__imgrow {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  min-width: 0;
}
.roto-assets__imgrow:hover {
  background: var(--surface);
}
.roto-assets__imgrow-thumb {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--surface);
  border: 1px solid var(--border-soft);
}
.roto-assets__imgrow-thumb img {
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
  flex-shrink: 0;
}
.roto-assets__video-row--loaded {
  background: var(--surface);
}
.roto-assets__video-row {
  cursor: pointer;
}
/* Visual single-click selection (item 2): subtle fill + a left accent rail.
   Inset box-shadow rather than a real border so the row doesn't reflow. */
.roto-assets__video-row--selected {
  background: var(--surface);
  box-shadow: inset 2px 0 0 var(--accent, #6ea8fe);
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
.roto-assets__video-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}
.roto-assets__btn {
  flex: none;
  padding: 2px 8px;
  font: inherit;
  font-size: 10px;
  color: var(--text-muted);
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: 3px;
  cursor: pointer;
}
.roto-assets__btn:hover {
  color: var(--text);
  border-color: var(--text-faint);
}
.roto-assets__remove {
  color: #fca5a5;
}
.roto-assets__remove:hover {
  color: #fff;
  background: #b91c1c;
  border-color: #b91c1c;
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
.roto-assets__toolbar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 8px;
  border-top: 1px solid var(--border-soft);
  background: var(--surface-alt);
}
.roto-assets__toolbar-side {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
/* The left group holds Sort + the search input and grows to fill the gap before
   the List/Grid buttons on the right (item 4). */
.roto-assets__toolbar-side--main {
  flex: 1 1 auto;
}
.roto-assets__search {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  min-width: 80px;
}
.roto-assets__search-input {
  font: inherit;
  font-size: 10px;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: 3px;
  padding: 2px 18px 2px 6px;
  width: 100%;
  outline: none;
}
.roto-assets__search-input:focus {
  border-color: var(--text-faint);
}
.roto-assets__search-clear {
  position: absolute;
  right: 2px;
  padding: 0 4px;
  font: inherit;
  font-size: 11px;
  line-height: 1;
  color: var(--text-faint);
  background: transparent;
  border: none;
  cursor: pointer;
}
.roto-assets__search-clear:hover {
  color: var(--text);
}
.roto-assets__tool-btn {
  flex: none;
  padding: 2px 8px;
  font: inherit;
  font-size: 10px;
  color: var(--text-muted);
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: 3px;
  cursor: pointer;
}
.roto-assets__tool-btn:hover {
  color: var(--text);
  border-color: var(--text-faint);
}
.roto-assets__tool-btn--active {
  color: var(--text);
  border-color: var(--text-faint);
  background: var(--surface-alt);
}
`;
