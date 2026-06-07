# Rotoscoping Bug Bash 3 — Asset Panel and Output Panel Improvements

Four improvements to the Project Assets pane and the Rotoscope Outputs pane.
Covers video persistence, panel UX (view modes, search, sort), clipboard copy for
output names, and wiring output metadata back to the original source video.

---

## 1. Video assets persist in the project until explicitly removed

**Problem.** `rotoStore.video` is session-only. Every time the app restarts or the
project changes, the user has to re-pick the source video from disk. There is no
record of which videos have been used with a project; the Project Assets panel
shows a "Load video..." button that starts fresh each time.

**Proposed behavior.** Source videos are registered as project-level assets and
shown as a persisted list in the Project Assets panel. The user adds a video once
per project and it stays until they explicitly remove it. The last-used video is
not automatically re-loaded on startup (the user double-clicks to load it into the
left pane), but it is not forgotten either.

**Implementation.**

Backend: new Rust commands on `src-tauri/src/commands/projects.rs`:

- `add_project_video(slug, path) -> ProjectVideo` -- appends to a `videos` array
  in the project's `project.json`. `ProjectVideo` is `{ path: String, addedAt: String (ISO-8601) }`.
- `remove_project_video(slug, path)` -- removes by path.
- `list_project_videos(slug) -> Vec<ProjectVideo>` -- reads from `project.json`.

The `project.json` schema gains an optional `"videos": [...]` array. The Rust
`Project` struct must annotate this field with `#[serde(default)]` so existing
`project.json` files that predate this change deserialize without error:

```rust
#[serde(default)]
pub videos: Vec<ProjectVideo>,
```

Without this, any `project.json` lacking the `"videos"` key will fail to
deserialize and the project will not load.

Frontend: `RotoAssetsPanel` subscribes to `list_project_videos` in the same way
it already subscribes to `list_assets`. Each row in the video list shows:
- The `[VIDEO]` badge and filename (basename of `path`).
- Full path on hover (tooltip).
- A "Load" button that calls `rotoStore.loadVideo({ path })`.
- A remove button (trash icon or "x") that calls `remove_project_video` and
  refreshes the list.

The "Load video..." file-picker button now calls `add_project_video` (saving the
path to the project) before calling `rotoStore.loadVideo`. This way adding a video
and using it are a single action. `add_project_video` must be idempotent: if the
path already exists in the `videos` array, skip the append rather than creating a
duplicate.

`rotoStore.loadVideo` behavior is unchanged -- it still sets the store's `video`
field for the current session and resets points/startFrame. Persistence is at the
project layer, not the store layer.

**"Clear" vs. remove distinction.** After this change there are two related
buttons in the panel:
- The existing "Clear" button on the currently-loaded video row calls
  `rotoStore.reset()`, which clears the session-only `rotoStore.video` but does
  NOT remove the video from the project list. The video remains in the persisted
  list and the user can re-load it later.
- The new remove button (per project-list row) calls `remove_project_video` to
  delete the entry from `project.json`, and optionally also calls `rotoStore.reset()`
  if the removed path matches the currently loaded video.

Render the "Clear" button only on the currently-loaded video highlight (if the
panel shows the loaded video inline), not on every list row, to keep the two
actions visually separate.

**Files:** `src-tauri/src/commands/projects.rs`,
`src/components/RotoPanel/RotoAssetsPanel.tsx`.

---

## 2. Assets panel bottom toolbar: view modes, zoom, search, sort

**Problem.** The Project Assets panel has no way to find a specific asset by name,
no way to sort, and no way to switch between the image grid and a filename-list
view.

**Proposed UX.** A slim toolbar row pinned to the bottom of the panel (above the
panel's bottom edge, below the scrollable content). It has two sides:

**Left side:**
- A search input (`filter by path`). Filters the displayed items (both videos and
  images) to those whose full path contains the search string (case-insensitive).
  Clears with an `x` button or pressing Escape.
- A "Sort" button that cycles through `name-asc` (default) and `name-desc`.
  Sorts are applied after the search filter.

**Right side:**
- Two icon buttons for view mode:
  - List view: the current `[VIDEO]` badge + filename row for videos, and
    a filename row for images (compact, single-line items).
  - Grid view: the existing thumbnail grid for images; videos show as a larger
    tile with a play icon overlay and the filename below (same 72px grid columns).
- `Ctrl +` / `Ctrl -` (when the panel is focused) increase / decrease the grid
  column min-width in 16px increments (clamped to 48px..120px). Has no effect in
  list view. Persists in `localStorage` under `claude-motion:rotoAssetsZoom`.

The view mode defaults to list and persists in `localStorage` under
`claude-motion:rotoAssetsView`.

**State.** All toolbar state is local to `RotoAssetsPanel`:
```ts
const [search, setSearch] = useState("");
const [sort, setSort] = useState<"name-asc" | "name-desc">("name-asc");
const [view, setView] = useState<"list" | "grid">(() => ...localStorage...);
const [zoom, setZoom] = useState<number>(() => ...localStorage...);
```

Filtering and sorting are computed in-render from the raw `assets` (images) and
`projectVideos` lists -- no backend round-trip needed.

**Files:** `src/components/RotoPanel/RotoAssetsPanel.tsx`.

---

## 3. Copy-name button on each rotoscope output row

**Problem.** When a user wants to tell Claude "use the output named X" to load it
in a Remotion animation or reference it by path, they have to manually select and
copy the output name, which is hidden inside a tooltip on hover.

**Fix.** Add a small clipboard icon button to the right of the output name (or
inline in the `roto-outputs__meta` column) that copies `o.name` to the clipboard:

```tsx
const [copied, setCopied] = useState<Record<string, boolean>>({});

// In the row:
<button
  type="button"
  title="Copy name"
  onClick={(e) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(o.name).then(() => {
      setCopied((prev) => ({ ...prev, [o.dir]: true }));
      setTimeout(
        () => setCopied((prev) => ({ ...prev, [o.dir]: false })),
        500,
      );
    });
  }}
>
  {copied[o.dir] ? "Copied!" : /* clipboard icon */}
</button>
```

The button is styled like the existing `roto-outputs__rename-btn` (visible on row
hover). The per-row `copied` state record drives the 500ms "Copied!" feedback.
Note: the implementation is slightly larger than a "three-line change" -- the
`copied` state declaration and the `.then()` callback are required additions.

**File:** `src/components/RotoPanel/RotoOutputsPanel.tsx`.

---

## 4. Output metadata links to source video; Compare resolves automatically

**Problem.** `RotoOutput` already has a `source: string | null` field, but it is
displayed nowhere in the panel and the comparison flow does not use it. If the
user has not manually loaded the source video in the Video pane, clicking "Compare"
in `RotoVideoPanel` falls through to disabled state even though the output knows
exactly which video it came from.

**What needs to change.**

**Backend.** `meta.json` is already written with the source path on the Rust side
(`rotoscoping.rs`, step 6 of finalization). `roto_media.rs` already deserializes
it into `RotoOutput.source`. No Python changes are needed -- `sam2_engine.py` does
not write `meta.json` and should not be in the touches list for this section.

**Frontend -- hover source path.** In `RotoOutputsPanel`, show the source video
basename in the `roto-outputs__frames` row (below the frame count) when
`o.source != null`, as faint text:

```
14 frames  |  source: clip.mp4
```

This surfaces the link between output and origin without adding a new UI element.

**Frontend -- Compare from the outputs panel.** Per PROPOSAL-roto-bugbash-3-controls
section 5, clicking the "Compare" button in `RotoOutputsPanel` should load the
stored `source_clip.mp4` from `files[o.dir]` as the comparison source. When
`sourceClip` is null but `o.source` is set, fall back to loading `o.source`
(the full original video) instead -- the comparison will be against the whole
source rather than the trimmed clip, but it is better than nothing.

**Store change.** The `loadVideoForComparison` action (from the controls proposal)
handles loading the video without clearing the sequence. The Compare button wiring
in `RotoOutputsPanel` depends on that action existing; ship the source-label
display independently first, and add the Compare button in the same PR as the
controls proposal (or after it merges).

**Files:** `src-tauri/src/commands/roto_media.rs` (read-only verify, no changes
expected), `src/components/RotoPanel/RotoOutputsPanel.tsx` (source label; Compare
button wiring gated on controls proposal).

---

---

## 5. Delete a rotoscope output

**Problem.** The only way to remove an output is to open the folder manually and
delete it from the OS. There is no delete action in the panel.

**Proposed UX.** A delete button (trash icon) on each output row, visible on
hover alongside the existing rename and action buttons. To prevent accidental
deletion, clicking it first replaces the row content with a confirmation prompt
("Delete? This removes all frames, the video, and the zip.") with "Delete" and
"Cancel" buttons. Confirming calls the backend command and removes the row
immediately.

**Backend.** New Rust command `delete_rotoscope_output(dir) -> ()` in
`src-tauri/src/commands/roto_media.rs`:
1. Validates that `dir` is a child of the project's `assets/` directory (prevents
   path-traversal deletion of arbitrary paths).
2. Calls `std::fs::remove_dir_all(dir)`.
3. Returns an error if the directory does not exist or is not inside `assets/`.

**Frontend.** On successful delete:
- Remove the row from local `outputs` state and the matching entry from `files`.
- If `rotoStore.loadedSequence?.dir === dir`, call `rotoStore.clearSequence()` so
  the Video pane does not try to play a sequence whose files are gone.
- No full `refresh()` call needed -- the local patch is sufficient.

**Files:** `src-tauri/src/commands/roto_media.rs`,
`src/components/RotoPanel/RotoOutputsPanel.tsx`.

---

## Implementation order

1. **Section 3** (copy button) -- two-minute change, zero deps. Do first.

2. **Section 4** (metadata / source link) -- verify backend source is written;
   add the panel label. The Compare fallback to `o.source` can land here even
   before the `source_clip.mp4` story is complete.

3. **Section 5** (delete output) -- isolated backend + frontend change, no deps.
   Can land alongside section 4.

4. **Section 1** (video persistence) -- requires new Rust commands. Medium scope.
   The UX in the assets panel is straightforward once the backend is up.

5. **Section 2** (toolbar) -- isolated panel UX. Can land in parallel with
   section 1 since it only touches `RotoAssetsPanel.tsx`. Keep the search/sort
   logic pure (no new backend commands) so this can ship without backend changes.
