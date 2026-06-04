// Top toolbar: project dropdown | + New | settings gear.
// Project list and settings dialog are filled in by later tickets;
// this ticket provides the shell and stable element boundaries.
function Toolbar() {
  return (
    <header className="toolbar">
      <div className="toolbar__left">
        <button className="toolbar__project" type="button" disabled>
          Untitled project
          <span className="toolbar__caret" aria-hidden="true">
            ▾
          </span>
        </button>
        <button className="toolbar__new" type="button" disabled>
          + New
        </button>
      </div>
      <div className="toolbar__right">
        <button
          className="toolbar__gear"
          type="button"
          aria-label="Settings"
          disabled
        >
          ⚙
        </button>
      </div>
    </header>
  );
}

export default Toolbar;
