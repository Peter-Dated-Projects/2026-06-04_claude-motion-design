import { useEffect, useRef, useState } from "react";
import { useProjectStore } from "../../store/projectStore";
import ProjectMenu from "./ProjectMenu";
import ExportMenu from "./ExportMenu";
import { ChevronDownIcon, GearIcon } from "../icons";

// Top toolbar: project selector | + New | Export / Project menus | settings gear.
// State for the active project and the project list comes from the project store;
// creating a project and opening settings are delegated to App via callbacks so the
// onboarding/settings modals live in one place.
interface ToolbarProps {
  onOpenSettings: () => void;
  onNewProject: () => void;
}

const DROPDOWN: React.CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  marginTop: 4,
  minWidth: 200,
  maxHeight: 320,
  overflowY: "auto",
  background: "#ffffff",
  border: "1px solid #d4d4d4",
  borderRadius: 6,
  boxShadow: "0 12px 32px rgba(0,0,0,0.15)",
  zIndex: 50,
  padding: 4,
};

const ITEM: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "transparent",
  border: "none",
  borderRadius: 4,
  padding: "7px 10px",
  fontSize: 13,
  color: "#1f1f1f",
  cursor: "pointer",
};

function Toolbar({ onOpenSettings, onNewProject }: ToolbarProps) {
  const projects = useProjectStore((s) => s.projects);
  const activeProject = useProjectStore((s) => s.activeProject);
  const openProject = useProjectStore((s) => s.openProject);

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Dismiss the project dropdown on any outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const pick = async (slug: string) => {
    setOpen(false);
    if (slug === activeProject?.slug) return;
    try {
      await openProject(slug);
    } catch {
      // Open failures surface elsewhere; keep the toolbar responsive.
    }
  };

  return (
    <header className="toolbar">
      <div className="toolbar__left">
        <div ref={wrapRef} style={{ position: "relative" }}>
          <button
            className="toolbar__project"
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={projects.length === 0}
            onClick={() => setOpen((v) => !v)}
          >
            {activeProject?.name ?? "No project"}
            <ChevronDownIcon className="toolbar__caret" />
          </button>
          {open && (
            <div style={DROPDOWN} role="menu">
              {projects.map((p) => (
                <button
                  key={p.slug}
                  type="button"
                  role="menuitem"
                  style={{
                    ...ITEM,
                    background:
                      p.slug === activeProject?.slug ? "#dbeafe" : "transparent",
                  }}
                  onClick={() => void pick(p.slug)}
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="toolbar__new" type="button" onClick={onNewProject}>
          + New
        </button>
      </div>
      <div className="toolbar__right">
        <ProjectMenu />
        <ExportMenu />
        <button
          className="toolbar__gear"
          type="button"
          aria-label="Settings"
          onClick={onOpenSettings}
        >
          <GearIcon />
        </button>
      </div>
    </header>
  );
}

export default Toolbar;
