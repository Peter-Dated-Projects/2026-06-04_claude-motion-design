import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  selectKeptFramePaths,
  useIGStore,
} from "../../store/igStore";
import {
  WORKSPACE_DEFS,
  useWorkspaceStore,
} from "../../store/workspaceStore";
import type { Brief } from "../../types/ig";

/**
 * The IG-stage "Brief" panel: the bottom slot of the IG workspace and the payoff
 * of the extraction pipeline. It is a pure consumer of the IG store (T-023) and
 * the workspace store (T-024) -- it owns no pipeline state and touches neither
 * the PTY nor the terminal panel.
 *
 * Phase-driven render (off `igStore.phase`):
 *   - idle / running-A : nothing actionable yet (a muted hint).
 *   - awaiting-review  : the 'Analyze' cost gate -- the one paid call. Disabled
 *                        when the user has kept zero frames (don't spend on an
 *                        empty set; mirrors the backend's zero-frame guard).
 *   - running-B        : a loading indicator; the Analyze action is GONE so the
 *                        paid call cannot be double-fired.
 *   - done             : the brief, read-only, plus 'Use as Style Reference'.
 *   - error            : the store's error message; no brief, no handoff button.
 *
 * The 'Use as Style Reference' handoff is the only place this panel calls
 * `invoke` directly (pipeline events stay in the store). It switches to the main
 * terminal-bearing project workspace, THEN types the brief into the Claude
 * terminal via `terminal_input` -- in that order so the typed text lands in a
 * terminal the user is already looking at.
 */

/** The explicit cost framing for the single paid Phase-B call. */
const ANALYZE_COST_HINT = "~$0.21";

/**
 * The main terminal-bearing project workspace -- the handoff target. Derived
 * from the workspace defs (the def whose `availablePanels` includes the terminal
 * singleton) rather than hardcoding a string literal, so this stays correct if
 * the def's id ever changes. Falls back to the first def defensively.
 */
const MAIN_WORKSPACE_ID =
  (WORKSPACE_DEFS.find((d) => d.availablePanels.includes("terminal")) ??
    WORKSPACE_DEFS[0]).id;

/**
 * The exact wrapper text from the proposal. Sent verbatim (em-dash and all) so
 * Claude receives the same framing every time. `<brief>` is the stored brief
 * object stringified. NOTE: no trailing newline/carriage-return -- pasting does
 * not submit, so the user reviews and hits enter in the terminal themselves.
 */
function buildHandoffText(brief: Brief): string {
  const json = JSON.stringify(brief, null, 2);
  return (
    "Here is a motion language brief extracted from a reference video.\n" +
    "Use it to create a Remotion composition with the same motion energy and theme —\n" +
    "not a copy of the source, but something new that moves and feels the same way.\n" +
    "\n" +
    `Brief: ${json}`
  );
}

/**
 * Wrap raw stdin in bracketed-paste markers so an interactive `claude` prompt
 * treats the whole multi-line block as a single paste rather than submitting on
 * the first embedded newline. This is just bytes in the `data` string -- no PTY
 * change. If end-to-end paste fidelity ever needs terminal-side handling, that
 * belongs to the integration ticket (T-032), not here.
 */
function bracketedPaste(text: string): string {
  return `[200~${text}[201~`;
}

// --- Small presentational helpers (inline-styled, self-contained) ----------

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-muted, #888)",
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 13, color: "var(--text, #1f1f1f)", lineHeight: 1.45 }}>
        {value}
      </span>
    </div>
  );
}

const PANEL_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  overflow: "auto",
  padding: 16,
  gap: 14,
  color: "var(--text, #1f1f1f)",
  fontSize: 13,
  boxSizing: "border-box",
};

const HINT_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  gap: 4,
  color: "var(--text-muted, #888)",
  fontSize: 13,
};

export default function BriefPanel() {
  const phase = useIGStore((s) => s.phase);
  const brief = useIGStore((s) => s.brief);
  const error = useIGStore((s) => s.error);
  const frames = useIGStore((s) => s.frames);
  const startPhaseB = useIGStore((s) => s.startPhaseB);
  const extractions = useIGStore((s) => s.extractions);
  const activeExtractionId = useIGStore((s) => s.activeExtractionId);

  // Drive the Analyze gate off the user-chosen kept set (overrides applied), not
  // the scorer's original kept set -- the user may have rejected every frame.
  const keptCount = selectKeptFramePaths(frames).length;

  // The store carries no dedicated extraction.md path field (T-023), so source it
  // from the matched past-extraction's folder. `dir` is `<out>/extractions/<date>_<id>/`
  // and extraction.md is its well-known leaf. Gracefully omitted if unavailable
  // (e.g. a just-finished run not yet in the sidebar list). See the KB seam note.
  const activeExtraction =
    extractions.find((e) => e.id === activeExtractionId) ?? null;
  const extractionMdPath = activeExtraction
    ? `${activeExtraction.dir.replace(/\/+$/, "")}/extraction.md`
    : null;

  const handleUseAsStyleReference = useCallback(async () => {
    const current = useIGStore.getState().brief;
    if (!current) return;
    // Order matters: switch FIRST (synchronous) so the terminal is on screen,
    // THEN type the brief into it.
    useWorkspaceStore.getState().setActiveWorkspace(MAIN_WORKSPACE_ID);
    const data = bracketedPaste(buildHandoffText(current));
    await invoke("terminal_input", { data });
  }, []);

  if (phase === "error") {
    return (
      <div style={PANEL_STYLE}>
        <div style={{ ...HINT_STYLE, color: "var(--error, #c5221f)" }}>
          <span style={{ fontWeight: 600 }}>Extraction failed</span>
          <span style={{ fontSize: 12, opacity: 0.85, textAlign: "center" }}>
            {error ?? "An unknown error occurred."}
          </span>
        </div>
      </div>
    );
  }

  if (phase === "awaiting-review") {
    const disabled = keptCount === 0;
    return (
      <div style={PANEL_STYLE}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Ready to analyze</span>
          <span style={{ fontSize: 12, color: "var(--text-secondary, #555)", lineHeight: 1.5 }}>
            {disabled
              ? "Keep at least one frame to run the analysis."
              : `${keptCount} frame${keptCount === 1 ? "" : "s"} selected. ` +
                "This runs one paid Claude call to extract the motion-language brief."}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              type="button"
              onClick={() => startPhaseB()}
              disabled={disabled}
              style={{
                padding: "7px 16px",
                borderRadius: 6,
                border: "1px solid var(--accent-strong, #1d4ed8)",
                background: disabled ? "var(--surface-alt, #f7f7f7)" : "var(--accent, #3b82f6)",
                color: disabled ? "var(--text-muted, #888)" : "#fff",
                fontSize: 13,
                fontWeight: 600,
                cursor: disabled ? "not-allowed" : "pointer",
              }}
            >
              Analyze
            </button>
            <span style={{ fontSize: 12, color: "var(--text-muted, #888)" }}>
              {ANALYZE_COST_HINT}
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "running-B") {
    return (
      <div style={PANEL_STYLE}>
        <div style={HINT_STYLE}>
          <span style={{ fontWeight: 600 }}>Analyzing motion language…</span>
          <span style={{ fontSize: 12, opacity: 0.85 }}>
            Extracting the brief from the kept frames.
          </span>
        </div>
      </div>
    );
  }

  if (phase === "done" && brief) {
    const ml = brief.motionLanguage;
    return (
      <div style={PANEL_STYLE}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Motion language brief</span>

          <Field label="Energy" value={ml.energy} />
          <Field label="Rhythm" value={ml.rhythm} />
          <Field label="Pacing" value={ml.pacing} />
          <Field label="Transitions" value={ml.transitions} />
          <Field label="Signature" value={ml.signature} />

          <div
            style={{
              height: 1,
              background: "var(--border-soft, #e0e0e0)",
              margin: "2px 0",
            }}
          />

          <Field label="Motion theme" value={brief.motionTheme} />
          <Field label="Color mood" value={brief.colorMood} />
          <Field label="Typography motion" value={brief.typographyMotion} />
          <Field label="Application guide" value={brief.applicationGuide} />
        </div>

        {extractionMdPath && (
          <span
            style={{
              fontSize: 11,
              color: "var(--text-faint, #999)",
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              wordBreak: "break-all",
            }}
          >
            Saved to {extractionMdPath}
          </span>
        )}

        <button
          type="button"
          onClick={handleUseAsStyleReference}
          style={{
            alignSelf: "flex-start",
            padding: "8px 18px",
            borderRadius: 6,
            border: "1px solid var(--accent-strong, #1d4ed8)",
            background: "var(--accent, #3b82f6)",
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Use as Style Reference
        </button>
      </div>
    );
  }

  // idle / running-A (and the unreachable done-without-brief fallback).
  return (
    <div style={PANEL_STYLE}>
      <div style={HINT_STYLE}>
        <span style={{ fontWeight: 600 }}>Brief</span>
        <span style={{ fontSize: 12, opacity: 0.7 }}>
          {phase === "running-A"
            ? "Extracting frames…"
            : "Run an extraction to generate a motion-language brief."}
        </span>
      </div>
    </div>
  );
}
