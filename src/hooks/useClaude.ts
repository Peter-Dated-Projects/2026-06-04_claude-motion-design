import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useProjectStore } from "../store/projectStore";
import { useUIStore } from "../store/uiStore";
import type { Message } from "../types";

// ---------------------------------------------------------------------------
// Event payloads emitted by the Rust Claude bridge (src-tauri/src/claude_bridge.rs).
// IMPORTANT: those payload structs carry NO `#[serde(rename_all)]`, so their
// fields stay snake_case over the wire — match them exactly here.
// ---------------------------------------------------------------------------
interface TokenPayload {
  text: string;
}
interface DonePayload {
  full_text: string;
  cost_usd: number | null;
  session_id: string | null;
}
interface ErrorPayload {
  message: string;
}

// ---------------------------------------------------------------------------
// Minimal stand-ins for the prompt-engineering helpers that T-027 (Prompt
// Engineering + Remotion Skills) owns. The integration ticket swaps these for
// the real module; the contracts (signatures) are what matter here.
// ---------------------------------------------------------------------------

/** Extract the first `<code>...</code>` block from a Claude response, if any. */
export function extractCode(text: string): string | null {
  const match = text.match(/<code>([\s\S]*?)<\/code>/);
  return match ? match[1].trim() : null;
}

/**
 * Assemble the full prompt sent to Claude from the user's request plus the
 * current editor state. Minimal stub: integration replaces this with T-027's
 * skill-aware builder.
 */
export function buildPrompt(
  userPrompt: string,
  currentCode?: string,
  selection?: string,
): string {
  const parts: string[] = [];
  if (currentCode && currentCode.trim().length > 0) {
    parts.push("Current animation code:\n```tsx\n" + currentCode + "\n```");
  }
  if (selection && selection.trim().length > 0) {
    parts.push("The user has selected this snippet:\n```tsx\n" + selection + "\n```");
  }
  parts.push(userPrompt);
  return parts.join("\n\n");
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface UseClaudeOptions {
  /**
   * Called with freshly generated animation code once a run finishes and a
   * `<code>` block is found. The parent (integration wiring) routes this into
   * the editor, mirroring how CodePanel takes its `code` from the parent.
   */
  onCodeGenerated?: (code: string) => void;
}

export interface UseClaude {
  messages: Message[];
  /** Live assistant text accumulating during a run (before it is finalized). */
  streamingText: string;
  isGenerating: boolean;
  /** True between `send` and the first streamed token. */
  isWaiting: boolean;
  error: string | null;
  send: (prompt: string) => Promise<void>;
  cancel: () => Promise<void>;
}

/**
 * Drives the chat conversation with the Claude CLI bridge: owns the message
 * list, streams tokens into a pending assistant bubble, finalizes on done,
 * extracts generated code, and persists the conversation per round.
 */
export function useClaude(options: UseClaudeOptions = {}): UseClaude {
  const { onCodeGenerated } = options;

  const activeProject = useProjectStore((s) => s.activeProject);
  const setIsGenerating = useUIStore((s) => s.setIsGenerating);

  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [isGenerating, setLocalGenerating] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The Claude session id for `--resume` continuity. Seeded from the active
  // project and refreshed from each `done` event. NOTE: there is no backend
  // command to persist this to project.json on its own (only conversations are
  // persisted), so cross-restart continuity is an integration gap — see the KB.
  const sessionIdRef = useRef<string | null>(activeProject?.sessionId ?? null);
  // Hold the latest messages so event callbacks (registered once) read fresh data.
  const messagesRef = useRef<Message[]>([]);
  const onCodeGeneratedRef = useRef(onCodeGenerated);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    onCodeGeneratedRef.current = onCodeGenerated;
  }, [onCodeGenerated]);

  const slug = activeProject?.slug ?? null;

  // Keep the shared generating flag in sync so other panels (e.g. the code
  // editor's read-only overlay) react to in-flight runs.
  const setGenerating = useCallback(
    (value: boolean) => {
      setLocalGenerating(value);
      setIsGenerating(value);
    },
    [setIsGenerating],
  );

  // Load the persisted conversation whenever the active project changes.
  useEffect(() => {
    let cancelled = false;
    if (!slug) {
      setMessages([]);
      sessionIdRef.current = null;
      return;
    }
    sessionIdRef.current = activeProject?.sessionId ?? null;
    invoke<Message[]>("load_conversation", { slug })
      .then((loaded) => {
        if (!cancelled) setMessages(loaded);
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, activeProject?.sessionId]);

  const persistConversation = useCallback(
    (next: Message[]) => {
      if (!slug) return;
      invoke("save_conversation", { slug, messages: next }).catch(() => {
        // Best-effort: a failed persist should not break the live chat.
      });
    },
    [slug],
  );

  // Register the streaming event listeners once.
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let disposed = false;

    const register = async () => {
      const onToken = await listen<TokenPayload>("claude://token", (event) => {
        setIsWaiting(false);
        setStreamingText((prev) => prev + event.payload.text);
      });

      const onDone = await listen<DonePayload>("claude://done", (event) => {
        const { full_text, session_id } = event.payload;
        if (session_id) sessionIdRef.current = session_id;

        const assistantMsg: Message = {
          role: "assistant",
          content: full_text,
          timestamp: nowIso(),
        };
        const next = [...messagesRef.current, assistantMsg];
        setMessages(next);
        setStreamingText("");
        setIsWaiting(false);
        setGenerating(false);
        persistConversation(next);

        const code = extractCode(full_text);
        if (code) onCodeGeneratedRef.current?.(code);
      });

      const onError = await listen<ErrorPayload>("claude://error", (event) => {
        setError(event.payload.message);
        setStreamingText("");
        setIsWaiting(false);
        setGenerating(false);
      });

      if (disposed) {
        onToken();
        onDone();
        onError();
        return;
      }
      unlisteners.push(onToken, onDone, onError);
    };

    register();
    return () => {
      disposed = true;
      for (const un of unlisteners) un();
    };
  }, [setGenerating, persistConversation]);

  const send = useCallback(
    async (prompt: string) => {
      const trimmed = prompt.trim();
      if (!trimmed || isGenerating) return;
      if (!slug) {
        setError("Open or create a project before chatting.");
        return;
      }

      setError(null);

      const userMsg: Message = {
        role: "user",
        content: trimmed,
        timestamp: nowIso(),
      };
      const withUser = [...messagesRef.current, userMsg];
      setMessages(withUser);
      persistConversation(withUser);

      setStreamingText("");
      setIsWaiting(true);
      setGenerating(true);

      const currentCode = await invoke<string>("load_animation", { slug }).catch(
        () => "",
      );
      const selection = useUIStore.getState().selection?.text;
      const fullPrompt = buildPrompt(trimmed, currentCode, selection);

      try {
        await invoke("invoke_claude", {
          slug,
          prompt: fullPrompt,
          sessionId: sessionIdRef.current,
        });
      } catch (e) {
        setError(typeof e === "string" ? e : String(e));
        setStreamingText("");
        setIsWaiting(false);
        setGenerating(false);
      }
    },
    [slug, isGenerating, persistConversation, setGenerating],
  );

  const cancel = useCallback(async () => {
    try {
      await invoke("cancel_claude");
    } catch {
      // Ignore — nothing in flight or bridge unavailable.
    }
    setStreamingText("");
    setIsWaiting(false);
    setGenerating(false);
  }, [setGenerating]);

  return {
    messages,
    streamingText,
    isGenerating,
    isWaiting,
    error,
    send,
    cancel,
  };
}
