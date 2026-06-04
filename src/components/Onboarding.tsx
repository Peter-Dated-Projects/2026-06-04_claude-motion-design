import { useEffect, useRef, useState } from "react";

// Startup gate + first-project prompt, shown as a modal overlay by App.
//
// Two phases:
//   - "install": the `claude` CLI was not found on PATH. Tells the user how to
//     install it and offers a "Check again" button that re-runs the detection.
//   - "project": Claude is ready but there is no project to work in. Prompts for
//     a name to create the first one. Reused (with cancelable=true) by the
//     toolbar's "+ New" action.
//
// Inline-styled to keep all integration UI self-contained (no shared CSS edits).

export type OnboardingPhase = "install" | "project";

interface OnboardingProps {
  phase: OnboardingPhase;
  /** Re-check in flight (install phase). */
  rechecking: boolean;
  onRecheck: () => void;
  /** Create in flight (project phase). */
  creating: boolean;
  onCreate: (name: string) => void;
  /** Whether the project prompt can be dismissed (true for "+ New", false on first run). */
  cancelable: boolean;
  onCancel?: () => void;
}

const OVERLAY: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  fontFamily: "Inter, sans-serif",
};

const CARD: React.CSSProperties = {
  width: 420,
  maxWidth: "90vw",
  background: "#ffffff",
  border: "1px solid #d4d4d4",
  borderRadius: 10,
  padding: 24,
  boxShadow: "0 24px 80px rgba(0,0,0,0.25)",
  color: "#1f1f1f",
};

const TITLE: React.CSSProperties = {
  margin: "0 0 12px",
  fontSize: 18,
  fontWeight: 600,
};

const BODY: React.CSSProperties = {
  margin: "0 0 18px",
  fontSize: 13,
  lineHeight: 1.6,
  color: "#555",
};

const CODE: React.CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  background: "#f0f0f0",
  border: "1px solid #d4d4d4",
  borderRadius: 4,
  padding: "1px 5px",
};

const INPUT: React.CSSProperties = {
  width: "100%",
  background: "#ffffff",
  color: "#1f1f1f",
  border: "1px solid #cfcfcf",
  borderRadius: 6,
  padding: "9px 11px",
  fontSize: 14,
  marginBottom: 16,
};

const ROW: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
};

function primaryBtn(disabled: boolean): React.CSSProperties {
  return {
    background: disabled ? "#93b4f0" : "#3b82f6",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "8px 16px",
    fontSize: 13,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.7 : 1,
  };
}

const SECONDARY_BTN: React.CSSProperties = {
  background: "#ffffff",
  color: "#1f1f1f",
  border: "1px solid #cfcfcf",
  borderRadius: 6,
  padding: "8px 16px",
  fontSize: 13,
  cursor: "pointer",
};

function Onboarding(props: OnboardingProps) {
  const { phase } = props;
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (phase === "project") inputRef.current?.focus();
  }, [phase]);

  if (phase === "install") {
    return (
      <div style={OVERLAY} role="dialog" aria-modal="true" aria-label="Claude Code required">
        <div style={CARD}>
          <h2 style={TITLE}>Claude Code not found</h2>
          <p style={BODY}>
            ClaudeMotion drives the <code style={CODE}>claude</code> CLI on your
            machine. Install it from <code style={CODE}>claude.ai/code</code>, then
            run <code style={CODE}>claude login</code> in your terminal. Once it is on
            your PATH, click "Check again".
          </p>
          <div style={ROW}>
            <button
              type="button"
              style={primaryBtn(props.rechecking)}
              disabled={props.rechecking}
              onClick={props.onRecheck}
            >
              {props.rechecking ? "Checking..." : "Check again"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const trimmed = name.trim();
  const submit = () => {
    if (!trimmed || props.creating) return;
    props.onCreate(trimmed);
  };

  return (
    <div style={OVERLAY} role="dialog" aria-modal="true" aria-label="Name your project">
      <div style={CARD}>
        <h2 style={TITLE}>Name your first animation project</h2>
        <p style={BODY}>
          Each project keeps its own animation code and chat history. Give this one
          a name to get started.
        </p>
        <input
          ref={inputRef}
          style={INPUT}
          type="text"
          placeholder="e.g. Product launch teaser"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape" && props.cancelable) {
              props.onCancel?.();
            }
          }}
        />
        <div style={ROW}>
          {props.cancelable && (
            <button type="button" style={SECONDARY_BTN} onClick={props.onCancel}>
              Cancel
            </button>
          )}
          <button
            type="button"
            style={primaryBtn(!trimmed || props.creating)}
            disabled={!trimmed || props.creating}
            onClick={submit}
          >
            {props.creating ? "Creating..." : "Create project"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default Onboarding;
