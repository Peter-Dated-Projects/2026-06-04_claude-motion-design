import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useProjectStore } from "../../store/projectStore";
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

// A dark theme that matches the app's panels.
const TERMINAL_THEME = {
  background: "#1a1a1a",
  foreground: "#f6f6f6",
  cursor: "#f6f6f6",
  selectionBackground: "#3a3a3a",
};

/**
 * Embedded interactive Claude Code terminal. Spawns (via the backend) a real
 * `claude` PTY session in the active project's directory; Claude edits
 * animation.tsx with its own tools, and the editor/preview track that file via
 * the separate `animation://changed` watcher (wired in App.tsx). This panel is
 * purely the terminal I/O surface.
 */
function TerminalPanel() {
  const slug = useProjectStore((s) => s.activeProject?.slug ?? null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [exited, setExited] = useState(false);

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
      theme: TERMINAL_THEME,
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
    };

    void register();
    return () => {
      disposed = true;
      for (const un of unlisteners) un();
    };
  }, []);

  // --- (Re-)open the PTY whenever the active project's slug changes. ---------
  useEffect(() => {
    if (!slug) return;
    setExited(false);
    termRef.current?.clear();

    void invoke("terminal_open", { slug })
      .then(() => {
        // Sync the PTY to the current terminal size right after open.
        const t = termRef.current;
        if (t) void invoke("terminal_resize", { cols: t.cols, rows: t.rows });
      })
      .catch(() => {
        setExited(true);
      });

    return () => {
      void invoke("terminal_close").catch(() => {});
    };
  }, [slug]);

  return (
    <section className="panel panel--terminal">
      <header className="panel__header terminalpanel__header">
        <span className="terminalpanel__title">Claude</span>
        {exited && (
          <span className="terminalpanel__status" role="status">
            session ended
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
      </div>
    </section>
  );
}

export default TerminalPanel;
