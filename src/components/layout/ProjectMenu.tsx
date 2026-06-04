// Project actions dropdown: Export ZIP / Import ZIP.
//
// Self-contained component. Mounted in the toolbar's right group (Toolbar.tsx).
// The dropdown floats below the trigger via the .project-menu /
// .project-menu__dropdown rules in App.css (position: relative wrapper +
// position: absolute panel, right-anchored).
//
// Export zips the active project; import opens a zip, extracts it, and opens the
// resulting project. Both Rust commands return a "cancelled" error string when
// the user dismisses the native file dialog -- that is not surfaced as an error.
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useProjectStore } from '../../store/projectStore';
import type { Project } from '../../types';

const CANCELLED = 'cancelled';

type Toast = { kind: 'success' | 'error'; text: string };

function ProjectMenu() {
  const activeProject = useProjectStore((s) => s.activeProject);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const openProject = useProjectStore((s) => s.openProject);

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

  const handleExport = async () => {
    setOpen(false);
    if (!activeProject || busy) return;
    setBusy(true);
    try {
      const path = await invoke<string>('export_project_zip', {
        slug: activeProject.slug,
      });
      setToast({ kind: 'success', text: `Saved to ${path}` });
    } catch (err) {
      const message = String(err);
      if (message !== CANCELLED) {
        setToast({ kind: 'error', text: `Export failed: ${message}` });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleReveal = async () => {
    setOpen(false);
    if (busy) return;
    // slug omitted falls back to the projects root, so this works even with no
    // project open.
    try {
      await invoke('reveal_project', { slug: activeProject?.slug ?? null });
    } catch (err) {
      setToast({ kind: 'error', text: `Reveal failed: ${String(err)}` });
    }
  };

  const handleImport = async () => {
    setOpen(false);
    if (busy) return;
    setBusy(true);
    try {
      const project = await invoke<Project>('import_project_zip');
      // Refresh the list and open the freshly imported project.
      await loadProjects();
      await openProject(project.slug);
      setToast({ kind: 'success', text: `Imported: ${project.name}` });
    } catch (err) {
      const message = String(err);
      if (message !== CANCELLED) {
        setToast({ kind: 'error', text: `Import failed: ${message}` });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="project-menu" ref={menuRef}>
      <button
        className="project-menu__trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
      >
        Project
        <span className="project-menu__caret" aria-hidden="true">
          {'▾'}
        </span>
      </button>

      {open && (
        <div className="project-menu__dropdown" role="menu">
          <button
            className="project-menu__item"
            type="button"
            role="menuitem"
            disabled={!activeProject || busy}
            onClick={handleExport}
          >
            Export ZIP
          </button>
          <button
            className="project-menu__item"
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={handleImport}
          >
            Import ZIP
          </button>
          <button
            className="project-menu__item"
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={handleReveal}
          >
            Reveal in Finder
          </button>
        </div>
      )}

      {toast && (
        <div
          className={`project-menu__toast project-menu__toast--${toast.kind}`}
          role="status"
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}

export default ProjectMenu;
