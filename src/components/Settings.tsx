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

const OVERLAY: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  fontFamily: "Inter, sans-serif",
};

const CARD: React.CSSProperties = {
  width: 520,
  maxWidth: "92vw",
  background: "#232323",
  border: "1px solid #3a3a3a",
  borderRadius: 10,
  padding: 24,
  boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
  color: "#f6f6f6",
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
  borderTop: "1px solid #333",
};

const LABEL: React.CSSProperties = {
  fontSize: 12,
  color: "#9a9a9a",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const VALUE: React.CSSProperties = {
  fontSize: 13,
  color: "#f6f6f6",
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
  background: "#2e2e2e",
  color: "#f6f6f6",
  border: "1px solid #3a3a3a",
  borderRadius: 6,
  width: 28,
  height: 28,
  fontSize: 16,
  lineHeight: 1,
  cursor: "pointer",
};

const REFRESH_BTN: React.CSSProperties = {
  background: "transparent",
  color: "#9ab",
  border: "1px solid #3a3a3a",
  borderRadius: 5,
  padding: "2px 8px",
  fontSize: 11,
  cursor: "pointer",
  marginLeft: 8,
};

function Settings({ open, onClose }: SettingsProps) {
  const [claudeInstalled, setClaudeInstalled] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [version, setVersion] = useState<string>("");
  const [skillsPath, setSkillsPath] = useState<string>("");
  const [mcpPath, setMcpPath] = useState<string>("");

  const recheckClaude = useCallback(async () => {
    setChecking(true);
    try {
      setClaudeInstalled(await invoke<boolean>("check_claude_installed"));
    } catch {
      setClaudeInstalled(false);
    } finally {
      setChecking(false);
    }
  }, []);

  // Load diagnostics each time the panel opens, so a freshly installed CLI or a
  // login change is reflected without restarting the app.
  useEffect(() => {
    if (!open) return;
    void recheckClaude();
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

  const claudeOk = claudeInstalled === true;
  // The Remotion docs MCP is wired through the CLI, so its reachability tracks the
  // CLI being available; the config itself is always bundled.
  const mcpOk = claudeOk;

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
            {claudeInstalled === null
              ? "Checking..."
              : claudeOk
                ? "Available on PATH (claude)"
                : "Not found on PATH"}
            <button
              type="button"
              style={REFRESH_BTN}
              disabled={checking}
              onClick={() => void recheckClaude()}
            >
              {checking ? "..." : "Re-check"}
            </button>
          </span>
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
