import type { ComponentType } from "react";
import { EditIcon, InstagramIcon, LayersIcon, RocketIcon } from "../icons";
import {
  useWorkspaceStore,
  WORKSPACE_DEFS,
  type WorkspaceIconKey,
} from "../../store/workspaceStore";
import { useRotoStore } from "../../store/rotoStore";

// "Rotoscope" stage icon -- a subject cut out of a frame: a dashed outer frame
// with a solid figure inside, evoking masking a subject from its background
// (SAM2). Defined here (not in icons.tsx) to keep this stage's wiring self-
// contained; matches the shared 16-viewBox / currentColor convention.
function RotoscopeIcon({ size = 15, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <rect x="2" y="2" width="12" height="12" rx="1.6" strokeDasharray="2.2 1.8" />
      <circle cx="8" cy="6.2" r="1.7" />
      <path d="M4.9 13a3.1 3.1 0 0 1 6.2 0" />
    </svg>
  );
}

// Maps a workspace's serializable icon key to its SVG component. A new stage
// gets a new key in workspaceStore + one row here -- nothing else to wire.
const ICONS: Record<WorkspaceIconKey, ComponentType<{ size?: number; className?: string }>> = {
  edit: EditIcon,
  layers: LayersIcon,
  rocket: RocketIcon,
  instagram: InstagramIcon,
  rotoscope: RotoscopeIcon,
};

// Bottom bar of workspace tabs -- the stages of the design workflow. The list
// is hard-coded config (WORKSPACE_DEFS); users switch between stages but can't
// create or configure them. Each tab switches which workspace's panel layout
// SplitLayout renders; the underlying Claude PTY / preview / editor panels are
// shared singletons that stay alive across the switch.
function WorkspaceBar() {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  // The rotoscoping stage is gated on the optional microservice: when it's not
  // reachable the tab is simply absent (no error UI), per the proposal. Every
  // other stage is always shown.
  const rotoAvailable = useRotoStore((s) => s.serviceAvailable);
  const defs = WORKSPACE_DEFS.filter((ws) => ws.id !== "roto" || rotoAvailable);

  return (
    <nav className="workspace-bar" aria-label="Workspaces">
      <div className="workspace-bar__tabs">
        {defs.map((ws) => {
          const Icon = ICONS[ws.icon] ?? LayersIcon;
          const active = ws.id === activeWorkspaceId;
          return (
            <button
              key={ws.id}
              type="button"
              className={`workspace-tab${active ? " workspace-tab--active" : ""}`}
              aria-current={active ? "page" : undefined}
              onClick={() => setActiveWorkspace(ws.id)}
            >
              <Icon className="workspace-tab__icon" />
              <span className="workspace-tab__label">{ws.name}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export default WorkspaceBar;
