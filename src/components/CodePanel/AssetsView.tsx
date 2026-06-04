import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { useProjectStore } from "../../store/projectStore";

/** An image in the active project's assets/ folder, with its bytes inlined as a
 *  base64 data URI for direct thumbnail rendering (see projects.rs::AssetFile). */
interface AssetFile {
  name: string;
  dataUri: string;
}

/** Extensions the backend accepts; used to filter a multi-file drop client-side
 *  so we don't round-trip obvious non-images. Must stay in sync with
 *  projects.rs::IMAGE_EXTS. */
const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

function isImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  const dot = file.name.lastIndexOf(".");
  const ext = dot === -1 ? "" : file.name.slice(dot + 1).toLowerCase();
  return IMAGE_EXTS.includes(ext);
}

/**
 * The Code panel's Assets view: a thumbnail grid of the active project's image
 * assets, with a drop zone to add more. Display-only -- assets are not editable
 * text and never open as Monaco tabs. Reads the active project's slug straight
 * from the project store (CodePanel isn't handed the slug as a prop).
 */
function AssetsView() {
  const slug = useProjectStore((s) => s.activeProject?.slug ?? null);

  const [assets, setAssets] = useState<AssetFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [adding, setAdding] = useState(false);
  const dragDepth = useRef(0);

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

  const addFiles = useCallback(
    async (files: File[]) => {
      if (!slug || files.length === 0) return;
      const images = files.filter(isImageFile);
      if (images.length === 0) {
        setError("Only image files can be added to assets.");
        return;
      }
      setAdding(true);
      setError(null);
      try {
        for (const file of images) {
          const buf = await file.arrayBuffer();
          const bytes = Array.from(new Uint8Array(buf));
          await invoke<AssetFile>("add_asset", {
            slug,
            name: file.name,
            bytes,
          });
        }
        await refresh();
      } catch (err) {
        setError(String(err));
      } finally {
        setAdding(false);
      }
    },
    [slug, refresh],
  );

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      void addFiles(files);
    },
    [addFiles],
  );

  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    // Required so the browser fires `drop` rather than navigating to the file.
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const onDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  }, []);

  if (!slug) {
    return <div className="assets__empty">No project open.</div>;
  }

  return (
    <div
      className={`assets${dragOver ? " assets--dragover" : ""}`}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
    >
      {error && <div className="assets__error">{error}</div>}

      {loading && assets.length === 0 ? (
        <div className="assets__empty">Loading...</div>
      ) : assets.length === 0 ? (
        <div className="assets__empty">
          No images yet.
          <br />
          Drag images here to add them.
        </div>
      ) : (
        <ul className="assets__grid">
          {assets.map((asset) => (
            <li key={asset.name} className="assets__item" title={asset.name}>
              <div className="assets__thumb">
                <img src={asset.dataUri} alt={asset.name} loading="lazy" />
              </div>
              <span className="assets__name">{asset.name}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="assets__hint">
        {adding ? "Adding..." : "Drop images to add"}
      </div>

      {dragOver && <div className="assets__dropmask">Drop to add images</div>}
    </div>
  );
}

export default AssetsView;
