# Conventions

Patterns and idioms *this specific repo* follows -- how code is structured, named, tested.

| Note | Summary | Status |
|---|---|---|
| [panel-layout-shell](panel-layout-shell.md) | The 3-panel layout owns sizing via .panel-slot wrappers in App.tsx; panel components fill their slot, not set their own width. | current |
| [panel-state-via-parent-props](panel-state-via-parent-props.md) | Cross-panel data flows through the parent via props/callbacks (ChatPanel onCodeGenerated, CodePanel code/onCodeChange), not custom DOM events; uiStore.isGenerating is the legit shared signal. | current |
| [app-owns-loop-state](app-owns-loop-state.md) | App.tsx is the integration root: owns the `code` state and the single useClaude instance; panels are controlled via props; edits/generations auto-save via save_animation. | current |
| [panel-visibility-tree-surgery](panel-visibility-tree-surgery.md) | Showing/hiding mosaic panels is manual MosaicNode tree surgery in App.tsx: getLeaves() is the source of truth, removeLeaf collapses a parent into its sibling, addLeaf docks a re-added panel, and a null layout renders an empty state. | current |
