---
id: optional-stage-service-gating
root: conventions
type: convention
status: current
summary: "An optional workspace stage (Rotoscope) lives in WORKSPACE_DEFS unconditionally; WorkspaceBar hides its tab by filtering on a store flag set at startup, and its progress event is wired in App.tsx so the store stays Tauri-free."
created: 2026-06-06
updated: 2026-06-06
---

The rotoscoping stage is OPTIONAL -- it depends on a Windows/GPU microservice that
may not be reachable. The pattern for gating it (T-003 shell):

**The stage def is always present.** `roto` is a normal entry in
`WORKSPACE_DEFS` (workspaceStore.ts) with its own `availablePanels` + `ROTO_LAYOUT`,
just like `ig`/`editing`. It is NOT conditionally added. So `DEFS_BY_ID`, the
persisted-layout sanitizer, and `selectActiveDef` all see it unconditionally.

**Visibility is a render-time filter in WorkspaceBar, not a def change.**
`WorkspaceBar` reads `useRotoStore(s => s.serviceAvailable)` and filters the def
out of the rendered tab list when false: `ws.id !== "roto" || rotoAvailable`. No
error UI -- the tab is simply absent (per the proposal). `serviceAvailable`
starts `false` and is set once at startup.

**Startup probe lives in App.tsx.** The first startup `useEffect` invokes
`check_rotoscoping_service({ host })` (host from localStorage key
`claude-motion:rotoHost`, default `localhost`; port is fixed at 7080 backend-side)
and calls `useRotoStore.getState().setServiceAvailability(status)`. The command
never errors (unreachable = normal), but it's guarded anyway.

**The store stays Tauri-free (mirrors igStore).** `rotoStore` is pure reducers;
no `invoke`/`listen` inside it. The `roto://progress` event is subscribed in a
dedicated app-level `useEffect` in App.tsx that forwards ticks to
`applyProgress`. The job-starting commands (`rotoscope_video` / `cancel_rotoscope`)
are wired by the panel tickets (T-004), also at the app boundary -- do NOT spread
Tauri calls into the store reducers.

See [[ig-panel-slot-contract]] for the slot/renderPanel mechanics (roto adds three
fixed slots roto-video / roto-assets / roto-outputs the same way) and
[[ig-frontend-contract-mirror]] for the camelCase type-mirror rule (src/types/roto.ts
mirrors the rotoscoping.rs payload structs).
