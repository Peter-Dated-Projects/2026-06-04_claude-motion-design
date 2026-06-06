// Export actions dropdown: Export TSX / Export MP4 / Export ZIP.
//
// Self-contained component, mirroring ProjectMenu.tsx. Mounted in the toolbar's
// right group (Toolbar.tsx). The dropdown floats below the trigger via the
// .export-menu / .export-menu__dropdown rules in App.css (position: relative
// wrapper + position: absolute panel, right-anchored).
//
// Export TSX writes the active project's animation.tsx to a chosen path (and
// copies its assets/ alongside). Export ZIP delegates to the project zip command.
// Export MP4 renders the animation to video (export_mp4 -> Node/Remotion) and is
// long-running, so it streams `export://progress` events shown as a percentage.
// Each Rust command returns a "cancelled" error string when the user dismisses
// the native file dialog -- that is not surfaced as an error.
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useProjectStore } from '../../store/projectStore';
import { ChevronDownIcon } from '../icons';

const CANCELLED = 'cancelled';
// Matches the sentinel `export_mp4` returns when no render toolchain is available
// (render_toolchain.rs); the UI turns it into the first-render install prompt.
const TOOLCHAIN_MISSING = 'TOOLCHAIN_MISSING';

type Toast = { kind: 'success' | 'error'; text: string };

const INSTALL_PHASE_LABEL: Record<string, string> = {
  download: 'Downloading',
  verify: 'Verifying',
  extract: 'Unpacking',
};

function ExportMenu() {
  const activeProject = useProjectStore((s) => s.activeProject);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  // Render progress (0..1) while an MP4 export runs; null when not rendering.
  const [progress, setProgress] = useState<number | null>(null);
  // First-render prompt: set with the download size when the render toolchain
  // isn't installed yet, so the user can opt into the one-time download.
  const [installPrompt, setInstallPrompt] = useState<{ sizeMb: number } | null>(
    null,
  );
  // Toolchain download/unpack progress while installing.
  const [install, setInstall] = useState<{ phase: string; progress: number } | null>(
    null,
  );
  const menuRef = useRef<HTMLDivElement>(null);

  // Dismiss the dropdown on any outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  // Auto-clear a toast after a few seconds.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  // Run an export command, sharing the busy/toast/cancel handling between the
  // TSX and ZIP paths.
  const runExport = async (command: string, label: string) => {
    setOpen(false);
    if (!activeProject || busy) return;
    setBusy(true);
    try {
      const path = await invoke<string>(command, { slug: activeProject.slug });
      setToast({ kind: 'success', text: `Saved to ${path}` });
    } catch (err) {
      const message = String(err);
      if (message !== CANCELLED) {
        setToast({ kind: 'error', text: `${label} failed: ${message}` });
      }
    } finally {
      setBusy(false);
    }
  };

  // The actual render: long-running (bundle + headless render), so the backend
  // streams `export://progress` events we surface as a determinate bar. The
  // first render also downloads a ~90MB headless Chrome, so the initial run can
  // take noticeably longer.
  const doRender = async () => {
    if (!activeProject) return;
    setBusy(true);
    setProgress(0);
    const unlisten = await listen<{ progress: number }>(
      'export://progress',
      (e) => setProgress(e.payload.progress),
    );
    try {
      const path = await invoke<string>('export_mp4', {
        slug: activeProject.slug,
      });
      setToast({ kind: 'success', text: `Saved to ${path}` });
    } catch (err) {
      const message = String(err);
      // Safety net: if the toolchain vanished between the status check and the
      // render, fall back to the install prompt instead of a cryptic error.
      if (message === TOOLCHAIN_MISSING) {
        const status = await invoke<{ sizeMb: number }>('render_toolchain_status');
        setInstallPrompt({ sizeMb: status.sizeMb });
      } else if (message !== CANCELLED) {
        setToast({ kind: 'error', text: `Export MP4 failed: ${message}` });
      }
    } finally {
      unlisten();
      setProgress(null);
      setBusy(false);
    }
  };

  // MP4 entry point: if the render toolchain (Node + the Remotion renderer) isn't
  // installed yet, surface the one-time-download prompt; otherwise render now.
  const runMp4Export = async () => {
    setOpen(false);
    if (!activeProject || busy) return;
    try {
      const status = await invoke<{ installed: boolean; sizeMb: number }>(
        'render_toolchain_status',
      );
      if (!status.installed) {
        setInstallPrompt({ sizeMb: status.sizeMb });
        return;
      }
    } catch {
      // If the status check itself fails, let the render attempt surface the real
      // error rather than blocking here.
    }
    void doRender();
  };

  // Download + unpack the render toolchain, streaming `toolchain://progress`, then
  // immediately proceed to render.
  const installThenRender = async () => {
    setInstallPrompt(null);
    setBusy(true);
    setInstall({ phase: 'download', progress: 0 });
    const unlisten = await listen<{ phase: string; progress: number }>(
      'toolchain://progress',
      (e) => setInstall(e.payload),
    );
    try {
      await invoke('install_render_toolchain');
    } catch (err) {
      const message = String(err);
      setToast({ kind: 'error', text: `Install failed: ${message}` });
      unlisten();
      setInstall(null);
      setBusy(false);
      return;
    }
    unlisten();
    setInstall(null);
    setBusy(false);
    void doRender();
  };

  return (
    <div className="export-menu" ref={menuRef}>
      <button
        className="export-menu__trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!activeProject || busy}
        onClick={() => setOpen((v) => !v)}
      >
        Export
        <ChevronDownIcon className="export-menu__caret" />
      </button>

      {open && (
        <div className="export-menu__dropdown" role="menu">
          <button
            className="export-menu__item"
            type="button"
            role="menuitem"
            disabled={!activeProject || busy}
            onClick={() => runExport('export_tsx', 'Export TSX')}
          >
            Export TSX
          </button>
          <button
            className="export-menu__item"
            type="button"
            role="menuitem"
            disabled={!activeProject || busy}
            onClick={() => void runMp4Export()}
          >
            Export MP4
          </button>
          <button
            className="export-menu__item"
            type="button"
            role="menuitem"
            disabled={!activeProject || busy}
            onClick={() => runExport('export_project_zip', 'Export ZIP')}
          >
            Export ZIP
          </button>
        </div>
      )}

      {installPrompt && (
        <div className="export-menu__toast" role="dialog" aria-modal="true">
          <div>
            MP4 export needs a one-time download of the video renderer
            {installPrompt.sizeMb > 0 ? ` (~${installPrompt.sizeMb} MB)` : ''}.
            Install now?
          </div>
          <div className="export-menu__prompt-actions">
            <button
              type="button"
              className="export-menu__item"
              onClick={() => void installThenRender()}
            >
              Install &amp; render
            </button>
            <button
              type="button"
              className="export-menu__item"
              onClick={() => setInstallPrompt(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {install && (
        <div className="export-menu__toast" role="status">
          {INSTALL_PHASE_LABEL[install.phase] ?? 'Installing'} renderer…
          {install.phase === 'download' && install.progress > 0
            ? ` ${Math.round(install.progress * 100)}%`
            : ''}
        </div>
      )}

      {progress !== null && (
        <div className="export-menu__toast" role="status">
          Rendering MP4… {Math.round(progress * 100)}%
        </div>
      )}

      {toast && progress === null && install === null && !installPrompt && (
        <div
          className={`export-menu__toast export-menu__toast--${toast.kind}`}
          role="status"
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}

export default ExportMenu;
