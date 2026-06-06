import type { ComponentType } from "react";
import { EditIcon, InstagramIcon, LayersIcon, RocketIcon } from "../icons";
import {
  useWorkspaceStore,
  WORKSPACE_DEFS,
  type WorkspaceIconKey,
} from "../../store/workspaceStore";

// Maps a workspace's serializable icon key to its SVG component. A new stage
// gets a new key in workspaceStore + one row here -- nothing else to wire.
const ICONS: Record<WorkspaceIconKey, ComponentType<{ size?: number; className?: string }>> = {
  edit: EditIcon,
  layers: LayersIcon,
  rocket: RocketIcon,
  instagram: InstagramIcon,
};

// Bottom bar of workspace tabs -- the stages of the design workflow. The list
// is hard-coded config (WORKSPACE_DEFS); users switch between stages but can't
// create or configure them. Each tab switches which workspace's panel layout
// SplitLayout renders; the underlying Claude PTY / preview / editor panels are
// shared singletons that stay alive across the switch.
function WorkspaceBar() {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);

  return (
    <nav className="workspace-bar" aria-label="Workspaces">
      <div className="workspace-bar__tabs">
        {WORKSPACE_DEFS.map((ws) => {
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
