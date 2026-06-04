import { useUIStore } from "../../store/uiStore";

// Bottom status bar: frame counter | fps | safe-zone toggle.
// Frame/fps read live playback state in later tickets; for now they show
// neutral placeholders. The safe-zone toggle is wired to the UI store and
// is fully functional so the overlay ticket can consume it.
function StatusBar() {
  const showSafeZone = useUIStore((s) => s.showSafeZone);
  const toggleSafeZone = useUIStore((s) => s.toggleSafeZone);

  return (
    <footer className="statusbar">
      <div className="statusbar__left">
        <span className="statusbar__metric">frame 0 / 0</span>
        <span className="statusbar__sep">|</span>
        <span className="statusbar__metric">30 fps</span>
      </div>
      <div className="statusbar__right">
        <button
          className="statusbar__toggle"
          type="button"
          aria-pressed={showSafeZone}
          onClick={toggleSafeZone}
        >
          Safe zones: {showSafeZone ? "on" : "off"}
        </button>
      </div>
    </footer>
  );
}

export default StatusBar;
