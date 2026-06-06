import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useProjectStore } from "../../store/projectStore";
import { useThemeStore } from "../../store/themeStore";
import "./TerminalPanel.css";

// ---------------------------------------------------------------------------
// Backend (PTY bridge) IPC contract — see the backend ticket. Payload structs
// carry no serde rename, so event fields stay snake_case over the wire.
// ---------------------------------------------------------------------------
interface DataPayload {
  data: string;
}
interface ExitPayload {
  code: number | null;
}

// xterm themes matching the app's light/dark panels. Selected by the active app
// theme; switching re-applies `term.options.theme` on the live instance.
const TERMINAL_THEME_LIGHT = {
  background: "#ffffff",
  foreground: "#1f1f1f",
  cursor: "#1f1f1f",
  selectionBackground: "#cfe0fb",
};

const TERMINAL_THEME_DARK = {
  background: "#1e1e1e",
  foreground: "#e6e6e6",
  cursor: "#e6e6e6",
  selectionBackground: "#27496f",
};

const terminalTheme = (theme: "light" | "dark") =>
  theme === "dark" ? TERMINAL_THEME_DARK : TERMINAL_THEME_LIGHT;

/**
 * Format dropped filesystem paths for insertion into the Claude prompt, matching
 * how a native terminal accepts a dragged file: absolute paths, space-separated,
 * each single-quoted only when it contains whitespace (so multi-file drops stay
 * unambiguous). No trailing newline — we insert at the prompt and let the user
 * keep typing rather than auto-submitting.
 */
function formatDroppedPaths(paths: string[]): string {
  return paths
    .map((p) => (/\s/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p))
    .join(" ");
}

/**
 * Embedded interactive Claude Code terminal. Spawns (via the backend) a real
 * `claude` PTY session in the active project's directory; Claude edits
 * animation.tsx with its own tools, and the editor/preview track that file via
 * the separate `animation://changed` watcher (wired in App.tsx). This panel is
 * purely the terminal I/O surface.
 */
function TerminalPanel() {
  const slug = useProjectStore((s) => s.activeProject?.slug ?? null);
  const theme = useThemeStore((s) => s.theme);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [exited, setExited] = useState(false);
  const [opening, setOpening] = useState(false);
  // Gate the first `terminal_open` until the data/exit listeners are registered.
  // Otherwise `claude`'s opening TUI frame can be emitted over `terminal://data`
  // before anyone is listening -- a blank terminal that looks like it never
  // started. This is the most likely cause of the "doesn't start on launch" bug.
  const [listening, setListening] = useState(false);
  // Highlights the terminal while files are dragged over it (native OS drag).
  const [dropActive, setDropActive] = useState(false);
  // Hard re-entrancy guard: blocks a double-spawn from rapid restart clicks or
  // an in-flight open racing a slug change, independent of React's async state.
  const openingRef = useRef(false);
  // The project we've already auto-opened a session for. Ensures the open effect
  // fires AT MOST ONCE per project: re-renders, `listening` toggling, or effect
  // re-runs for the SAME slug must not respawn (and thus reset) a live session.
  const openedSlugRef = useRef<string | null>(null);

  // --- The single (re)open path, shared by the [slug] effect and the Restart
  //     button. PtyBridge::open kills any predecessor + spawns fresh, so calling
  //     terminal_open again for the same slug is safe. ---------------------------
  const openSession = useCallback(async () => {
    if (!slug || openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setExited(false);
    termRef.current?.clear();
    try {
      await invoke("terminal_open", { slug });
      // Sync the PTY to the current terminal size right after open.
      const t = termRef.current;
      if (t) await invoke("terminal_resize", { cols: t.cols, rows: t.rows });
    } catch {
      setExited(true);
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  }, [slug]);

  // --- Create the xterm instance once and mount it into the host div. --------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily:
        '"SF Mono", "JetBrains Mono", Menlo, Consolas, "Courier New", monospace',
      fontSize: 12,
      // Seed from the current theme; a separate effect keeps it in sync. Read
      // via getState so this create-once effect doesn't depend on `theme`.
      theme: terminalTheme(useThemeStore.getState().theme),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    // Pipe keystrokes to the PTY stdin (raw bytes, incl. control chars).
    const dataDisposable = term.onData((data) => {
      void invoke("terminal_input", { data }).catch(() => {});
    });

    // Keep the PTY sized to the visible terminal.
    const pushResize = () => {
      const f = fitRef.current;
      const t = termRef.current;
      if (!f || !t) return;
      try {
        f.fit();
      } catch {
        // fit can throw if the host has zero size mid-layout; ignore.
      }
      void invoke("terminal_resize", { cols: t.cols, rows: t.rows }).catch(
        () => {},
      );
    };
    const resizeObserver = new ResizeObserver(() => pushResize());
    resizeObserver.observe(host);

    return () => {
      dataDisposable.dispose();
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // --- Re-skin the live terminal when the app theme changes. -----------------
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = terminalTheme(theme);
  }, [theme]);

  // --- Stream PTY output + exit into the terminal. ---------------------------
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let disposed = false;

    const register = async () => {
      const onData = await listen<DataPayload>("terminal://data", (event) => {
        termRef.current?.write(event.payload.data);
      });
      const onExit = await listen<ExitPayload>("terminal://exit", () => {
        setExited(true);
      });
      if (disposed) {
        onData();
        onExit();
        return;
      }
      unlisteners.push(onData, onExit);
      setListening(true);
    };

    void register();
    return () => {
      disposed = true;
      setListening(false);
      for (const un of unlisteners) un();
    };
  }, []);

  // --- Native OS drag-and-drop of files onto the terminal. -------------------
  //     This window uses Tauri's native drag-drop (the default), so the only way
  //     to get a dropped file's real filesystem path is `onDragDropEvent` — the
  //     HTML5 dataTransfer API never exposes absolute paths in a webview. The
  //     event is window-global, so we hit-test the drop position against the
  //     terminal host's rect and only act when the drop lands over us. On drop
  //     we write the path(s) into the PTY stdin; the CLI echoes them back at the
  //     prompt, just like dragging a file into a real terminal.
  useEffect(() => {
    // Is a window-physical-pixel point inside the terminal host? getBoundingClientRect
    // is in CSS pixels, so scale the physical position down by the device ratio.
    const isOverHost = (x: number, y: number): boolean => {
      const host = hostRef.current;
      if (!host) return false;
      const dpr = window.devicePixelRatio || 1;
      const lx = x / dpr;
      const ly = y / dpr;
      const r = host.getBoundingClientRect();
      return lx >= r.left && lx <= r.right && ly >= r.top && ly <= r.bottom;
    };

    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    // Whether the most recent enter/over hovered the terminal host. We gate the
    // drop on THIS rather than re-hit-testing the drop event's own position: the
    // `drop` payload's position is documented as unreliable (notably inaccurate
    // while devtools is attached), whereas the enter/over stream is accurate.
    let overHost = false;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          overHost = isOverHost(p.position.x, p.position.y);
          setDropActive(overHost);
        } else if (p.type === "leave") {
          overHost = false;
          setDropActive(false);
        } else if (p.type === "drop") {
          setDropActive(false);
          const wasOverHost = overHost;
          overHost = false;
          if (!p.paths.length || !wasOverHost) return;
          const data = formatDroppedPaths(p.paths);
          if (data) void invoke("terminal_input", { data }).catch(() => {});
        }
      })
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // --- (Re-)open the PTY whenever the active project's slug changes. ---------
  //     Wait for `listening` so we never miss claude's first frame (see above).
  //     We deliberately DO NOT close the PTY on cleanup: the session is
  //     project-scoped, not component-scoped. terminal_open already supersedes
  //     (kills + respawns) the predecessor on a project switch, so an explicit
  //     terminal_close here only created a fire-and-forget call that could race
  //     -- and win against -- the next open, killing a freshly spawned session.
  //     It also meant the live `claude` was torn down whenever this component
  //     remounted (e.g. a panel rearrange), which is the session-dies bug.
  useEffect(() => {
    if (!slug || !listening) return;
    if (openedSlugRef.current === slug) return; // already opened this project
    openedSlugRef.current = slug;
    void openSession();
  }, [slug, listening, openSession]);

  return (
    <section className="panel panel--terminal">
      <header className="panel__header terminalpanel__header">
        <span className="terminalpanel__title">Claude</span>
        {exited && (
          <span className="terminalpanel__header-end">
            <span className="terminalpanel__status" role="status">
              session ended
            </span>
            <button
              type="button"
              className="terminalpanel__restart"
              onClick={() => void openSession()}
              disabled={!slug || opening}
            >
              Restart
            </button>
          </span>
        )}
      </header>
      <div className="terminalpanel__body">
        {!slug && (
          <div className="terminalpanel__placeholder">
            Open or create a project to start a Claude session.
          </div>
        )}
        <div ref={hostRef} className="terminalpanel__host" />
        {dropActive && (
          <div className="terminalpanel__dropmask">Drop file to add its path</div>
        )}
      </div>
    </section>
  );
}

export default TerminalPanel;
