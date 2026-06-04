// Export actions dropdown: Export TSX / Export MP4 (coming soon) / Export ZIP.
//
// Self-contained component, mirroring ProjectMenu.tsx. Mounted in the toolbar's
// right group (Toolbar.tsx). The dropdown floats below the trigger via the
// .export-menu / .export-menu__dropdown rules in App.css (position: relative
// wrapper + position: absolute panel, right-anchored).
//
// Export TSX writes the active project's animation.tsx to a chosen path (and
// copies its assets/ alongside). Export ZIP delegates to the project zip command.
// Both Rust commands return a "cancelled" error string when the user dismisses
// the native file dialog -- that is not surfaced as an error.
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useProjectStore } from '../../store/projectStore';

const CANCELLED = 'cancelled';

type Toast = { kind: 'success' | 'error'; text: string };

function ExportMenu() {
  const activeProject = useProjectStore((s) => s.activeProject);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
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
        <span className="export-menu__caret" aria-hidden="true">
          {'▾'}
        </span>
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
            disabled
            title="Coming soon"
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

      {toast && (
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
