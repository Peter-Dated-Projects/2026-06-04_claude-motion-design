import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { appDataDir, join } from "@tauri-apps/api/path";

// Settings panel (gear icon). Read-only diagnostics about the local Claude setup:
// CLI availability, the Remotion docs MCP, the bundled skills prompt path, and the
// app version. Everything here is derived from real backend state -- no fabricated
// controls. Inline-styled to keep integration UI self-contained.

interface SettingsProps {
  open: boolean;
  onClose: () => void;
}

// Mirrors the Rust `ClaudeCliInfo` returned by `get_claude_cli`.
interface ClaudeCliInfo {
  detected: string | null;
  override_path: string | null;
  effective: string;
  available: boolean;
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
  width: 520,
  maxWidth: "92vw",
  background: "#ffffff",
  border: "1px solid #d4d4d4",
  borderRadius: 10,
  padding: 24,
  boxShadow: "0 24px 80px rgba(0,0,0,0.25)",
  color: "#1f1f1f",
};

const HEADER: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 18,
};

const ROW: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "12px 0",
  borderTop: "1px solid #e0e0e0",
};

const LABEL: React.CSSProperties = {
  fontSize: 12,
  color: "#888",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const VALUE: React.CSSProperties = {
  fontSize: 13,
  color: "#1f1f1f",
  fontFamily: "ui-monospace, monospace",
  wordBreak: "break-all",
};

function dot(ok: boolean): React.CSSProperties {
  return {
    display: "inline-block",
    width: 9,
    height: 9,
    borderRadius: "50%",
    background: ok ? "#22c55e" : "#ef4444",
    marginRight: 7,
  };
}

const CLOSE_BTN: React.CSSProperties = {
  background: "#ffffff",
  color: "#1f1f1f",
  border: "1px solid #cfcfcf",
  borderRadius: 6,
  width: 28,
  height: 28,
  fontSize: 16,
  lineHeight: 1,
  cursor: "pointer",
};

const REFRESH_BTN: React.CSSProperties = {
  background: "transparent",
  color: "#3b82f6",
  border: "1px solid #cfcfcf",
  borderRadius: 5,
  padding: "2px 8px",
  fontSize: 11,
  cursor: "pointer",
  marginLeft: 8,
};

const PATH_INPUT: React.CSSProperties = {
  flex: 1,
  background: "#ffffff",
  color: "#1f1f1f",
  border: "1px solid #cfcfcf",
  borderRadius: 5,
  padding: "5px 8px",
  fontSize: 12,
  fontFamily: "ui-monospace, monospace",
};

const SMALL_BTN: React.CSSProperties = {
  background: "#ffffff",
  color: "#1f1f1f",
  border: "1px solid #cfcfcf",
  borderRadius: 5,
  padding: "5px 10px",
  fontSize: 12,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

function Settings({ open, onClose }: SettingsProps) {
  const [cli, setCli] = useState<ClaudeCliInfo | null>(null);
  const [overrideInput, setOverrideInput] = useState("");
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState<string>("");
  const [skillsPath, setSkillsPath] = useState<string>("");
  const [mcpPath, setMcpPath] = useState<string>("");

  const recheckClaude = useCallback(async (syncInput = false) => {
    setChecking(true);
    try {
      const info = await invoke<ClaudeCliInfo>("get_claude_cli");
      setCli(info);
      // Only reseed the editable field when (re)opening, not after every check,
      // so it doesn't clobber what the user is typing.
      if (syncInput) setOverrideInput(info.override_path ?? "");
    } catch {
      setCli(null);
    } finally {
      setChecking(false);
    }
  }, []);

  // Persist (or clear, with an empty string) the CLI override, then re-check so
  // the detected/effective/available readout reflects the new binary.
  const saveOverride = useCallback(
    async (next: string | null) => {
      setSaving(true);
      try {
        await invoke("set_claude_cli", { path: next });
        setOverrideInput(next ?? "");
        await recheckClaude(false);
      } catch {
        // Leave the field as-is; the readout simply won't change.
      } finally {
        setSaving(false);
      }
    },
    [recheckClaude],
  );

  // Load diagnostics each time the panel opens, so a freshly installed CLI or a
  // login change is reflected without restarting the app.
  useEffect(() => {
    if (!open) return;
    void recheckClaude(true);
    getVersion()
      .then(setVersion)
      .catch(() => setVersion("unknown"));
    appDataDir()
      .then(async (base) => {
        const dir = await join(base, "claude-config");
        setSkillsPath(await join(dir, "remotion-skills.txt"));
        setMcpPath(await join(dir, "remotion-mcp-config.json"));
      })
      .catch(() => {
        setSkillsPath("unavailable");
        setMcpPath("unavailable");
      });
  }, [open, recheckClaude]);

  // Close on Escape while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const claudeOk = cli?.available === true;
  // The Remotion docs MCP is wired through the CLI, so its reachability tracks the
  // CLI being available; the config itself is always bundled.
  const mcpOk = claudeOk;
  const trimmedOverride = overrideInput.trim();
  const overrideDirty = trimmedOverride !== (cli?.override_path ?? "");

  return (
    <div
      style={OVERLAY}
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={CARD}>
        <div style={HEADER}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Settings</h2>
          <button type="button" style={CLOSE_BTN} aria-label="Close settings" onClick={onClose}>
            x
          </button>
        </div>

        <div style={{ ...ROW, borderTop: "none", paddingTop: 0 }}>
          <span style={LABEL}>Claude CLI</span>
          <span style={VALUE}>
            <span style={dot(claudeOk)} />
            {cli === null
              ? "Checking..."
              : claudeOk
                ? `Runnable: ${cli.effective}`
                : `Not runnable: ${cli.effective}`}
            <button
              type="button"
              style={REFRESH_BTN}
              disabled={checking}
              onClick={() => void recheckClaude(false)}
            >
              {checking ? "..." : "Re-check"}
            </button>
          </span>
          <span style={{ ...LABEL, textTransform: "none", marginTop: 6 }}>
            Auto-detected (which claude):{" "}
            <span style={{ fontFamily: "ui-monospace, monospace", color: "#555" }}>
              {cli === null ? "..." : cli.detected ?? "not found on PATH"}
            </span>
          </span>
          <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
            <input
              style={PATH_INPUT}
              type="text"
              spellCheck={false}
              placeholder="Override path (leave blank to use PATH)"
              value={overrideInput}
              onChange={(e) => setOverrideInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && overrideDirty && !saving) {
                  e.preventDefault();
                  void saveOverride(trimmedOverride || null);
                }
              }}
            />
            <button
              type="button"
              style={{
                ...SMALL_BTN,
                opacity: overrideDirty && !saving ? 1 : 0.6,
                cursor: overrideDirty && !saving ? "pointer" : "default",
              }}
              disabled={!overrideDirty || saving}
              onClick={() => void saveOverride(trimmedOverride || null)}
            >
              {saving ? "..." : "Save"}
            </button>
            <button
              type="button"
              style={{
                ...SMALL_BTN,
                opacity: cli?.override_path && !saving ? 1 : 0.6,
                cursor: cli?.override_path && !saving ? "pointer" : "default",
              }}
              disabled={!cli?.override_path || saving}
              onClick={() => void saveOverride(null)}
            >
              Clear
            </button>
          </div>
        </div>

        <div style={ROW}>
          <span style={LABEL}>Remotion docs MCP</span>
          <span style={VALUE}>
            <span style={dot(mcpOk)} />
            {mcpOk ? "Configured (@remotion/mcp)" : "Unavailable (CLI offline)"}
          </span>
        </div>

        <div style={ROW}>
          <span style={LABEL}>Skills prompt</span>
          <span style={VALUE}>{skillsPath || "..."}</span>
        </div>

        <div style={ROW}>
          <span style={LABEL}>MCP config</span>
          <span style={VALUE}>{mcpPath || "..."}</span>
        </div>

        <div style={ROW}>
          <span style={LABEL}>App version</span>
          <span style={VALUE}>{version || "..."}</span>
        </div>
      </div>
    </div>
  );
}

export default Settings;
