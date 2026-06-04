import { useCallback, useRef } from "react";
import "./App.css";
import Toolbar from "./components/layout/Toolbar";
import StatusBar from "./components/layout/StatusBar";
import ChatPanel from "./components/ChatPanel/ChatPanel";
import CodePanel from "./components/CodePanel/CodePanel";
import PreviewPanel from "./components/PreviewPanel/PreviewPanel";
import { useUIStore } from "./store/uiStore";

const MIN_PANEL_PX = 180;

function App() {
  const panelWidths = useUIStore((s) => s.panelWidths);
  const setPanelWidths = useUIStore((s) => s.setPanelWidths);
  const panelsRef = useRef<HTMLDivElement>(null);

  // Drag a handle that sits between panel `index` and panel `index + 1`.
  // Only those two panels resize; their combined width is conserved so the
  // other panel never shifts. Widths are stored as percentages.
  const startDrag = useCallback(
    (index: number) => (e: React.MouseEvent) => {
      e.preventDefault();
      const container = panelsRef.current;
      if (!container) return;

      const containerWidth = container.getBoundingClientRect().width;
      const minPct = (MIN_PANEL_PX / containerWidth) * 100;
      const startX = e.clientX;
      const startWidths = useUIStore.getState().panelWidths;
      const combined = startWidths[index] + startWidths[index + 1];

      const onMove = (move: MouseEvent) => {
        const deltaPct = ((move.clientX - startX) / containerWidth) * 100;
        let left = startWidths[index] + deltaPct;
        // Clamp both panels to the minimum width.
        left = Math.max(minPct, Math.min(combined - minPct, left));
        const right = combined - left;

        const next = [...startWidths] as [number, number, number];
        next[index] = left;
        next[index + 1] = right;
        setPanelWidths(next);
      };

      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.classList.remove("is-resizing");
      };

      document.body.classList.add("is-resizing");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [setPanelWidths],
  );

  return (
    <div className="app">
      <Toolbar />
      <div className="panels" ref={panelsRef}>
        <div className="panel-slot" style={{ flexBasis: `${panelWidths[0]}%` }}>
          <ChatPanel />
        </div>
        <div
          className="resize-handle"
          role="separator"
          aria-orientation="vertical"
          onMouseDown={startDrag(0)}
        />
        <div className="panel-slot" style={{ flexBasis: `${panelWidths[1]}%` }}>
          <CodePanel />
        </div>
        <div
          className="resize-handle"
          role="separator"
          aria-orientation="vertical"
          onMouseDown={startDrag(1)}
        />
        <div className="panel-slot" style={{ flexBasis: `${panelWidths[2]}%` }}>
          <PreviewPanel />
        </div>
      </div>
      <StatusBar />
    </div>
  );
}

export default App;
