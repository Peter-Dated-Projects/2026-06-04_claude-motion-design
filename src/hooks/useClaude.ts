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

// ---------------------------------------------------------------------------
// Lazy esbuild validation worker.
//
// Before generated code reaches the editor/preview, we run it through the same
// sandbox compiler the preview uses (src/workers/sandbox-compiler.worker.ts) in
// transform mode: a `compiled` reply means the TSX is structurally valid, an
// `error` reply is a syntax/transform failure we can feed back to Claude. This
// is a SECOND esbuild-wasm instance (the preview owns its own); it is created
// lazily on the first validation so the ~12 MB wasm init is only paid once a
// generation actually completes, never at app start.
// ---------------------------------------------------------------------------
type ValidationResult = { ok: true } | { ok: false; message: string };

/** Maximum number of "code didn't compile, please fix" round-trips per request. */
const MAX_VALIDATION_RETRIES = 2;

let validationWorker: Worker | null = null;
let validationSeq = 0;
const pendingValidations = new Map<number, (r: ValidationResult) => void>();

function getValidationWorker(): Worker {
  if (!validationWorker) {
    validationWorker = new Worker(
      new URL("../workers/sandbox-compiler.worker.ts", import.meta.url),
      { type: "module" },
    );
    validationWorker.onmessage = (ev: MessageEvent) => {
      const data = ev.data as { type: string; message?: string; id?: number };
      if (typeof data.id !== "number") return;
      const resolve = pendingValidations.get(data.id);
      if (!resolve) return;
      pendingValidations.delete(data.id);
      resolve(
        data.type === "compiled"
          ? { ok: true }
          : { ok: false, message: data.message ?? "Unknown compile error" },
      );
    };
    validationWorker.onerror = () => {
      // If the validator itself crashes, fail OPEN (treat code as valid) rather
      // than trap the user behind a broken gate; the preview still surfaces any
      // real runtime error in its red banner.
      for (const resolve of pendingValidations.values()) resolve({ ok: true });
      pendingValidations.clear();
    };
  }
  return validationWorker;
}

/** Transform-compile `code` to confirm it has no syntax/transform errors. */
function validateCode(code: string): Promise<ValidationResult> {
  return new Promise((resolve) => {
    const id = ++validationSeq;
    pendingValidations.set(id, resolve);
    getValidationWorker().postMessage({ type: "compile", code, id });
  });
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
  // How many compile-fix retries the current request has already spent.
  const retryCountRef = useRef(0);
  // Latest active slug, read by the (re-)invoke inside the done handler.
  const slugRef = useRef<string | null>(activeProject?.slug ?? null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    onCodeGeneratedRef.current = onCodeGenerated;
  }, [onCodeGenerated]);

  const slug = activeProject?.slug ?? null;
  useEffect(() => {
    slugRef.current = slug;
  }, [slug]);

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

    // Append the final assistant turn to the visible/persisted conversation.
    const finalizeAssistant = (fullText: string) => {
      const assistantMsg: Message = {
        role: "assistant",
        content: fullText,
        timestamp: nowIso(),
      };
      const next = [...messagesRef.current, assistantMsg];
      setMessages(next);
      persistConversation(next);
    };

    // Handle a completed Claude turn: extract code, validate it, and either
    // accept it, ask Claude to fix a compile error (up to MAX_VALIDATION_RETRIES),
    // or give up and surface the broken code so the preview shows the real error.
    const handleDone = async (payload: DonePayload) => {
      const { full_text, session_id } = payload;
      if (session_id) sessionIdRef.current = session_id;
      setStreamingText("");
      setIsWaiting(false);

      const code = extractCode(full_text);
      if (!code) {
        // Conversational reply with no <code> block -> just finalize.
        finalizeAssistant(full_text);
        setGenerating(false);
        retryCountRef.current = 0;
        return;
      }

      const result = await validateCode(code);
      if (result.ok) {
        finalizeAssistant(full_text);
        setGenerating(false);
        retryCountRef.current = 0;
        onCodeGeneratedRef.current?.(code);
        return;
      }

      // Code did not compile. Ask Claude to fix it, up to the retry cap. The
      // failed attempt is NOT shown as a chat bubble — only the terminal turn
      // lands in the conversation; the live streaming bubble simply resets.
      if (retryCountRef.current < MAX_VALIDATION_RETRIES && slugRef.current) {
        retryCountRef.current += 1;
        const fixPrompt =
          "The TSX you returned does not compile. esbuild reported:\n" +
          `<error>\n${result.message}\n</error>\n` +
          "Return the COMPLETE corrected file in a single <code> tag, no prose.";
        setStreamingText("");
        setIsWaiting(true);
        // generating stays true across the fix round-trip
        try {
          await invoke("invoke_claude", {
            slug: slugRef.current,
            prompt: fixPrompt,
            sessionId: sessionIdRef.current,
          });
        } catch (e) {
          setError(typeof e === "string" ? e : String(e));
          setIsWaiting(false);
          setGenerating(false);
          retryCountRef.current = 0;
        }
        return;
      }

      // Retries exhausted: accept the last attempt anyway so the preview's red
      // banner shows the actual compile error, and tell the user via `error`.
      finalizeAssistant(full_text);
      setGenerating(false);
      retryCountRef.current = 0;
      onCodeGeneratedRef.current?.(code);
      setError(
        `Generated code still failed to compile after ${MAX_VALIDATION_RETRIES} retries: ${result.message}`,
      );
    };

    const register = async () => {
      const onToken = await listen<TokenPayload>("claude://token", (event) => {
        setIsWaiting(false);
        setStreamingText((prev) => prev + event.payload.text);
      });

      const onDone = await listen<DonePayload>("claude://done", (event) => {
        void handleDone(event.payload);
      });

      const onError = await listen<ErrorPayload>("claude://error", (event) => {
        setError(event.payload.message);
        setStreamingText("");
        setIsWaiting(false);
        setGenerating(false);
        retryCountRef.current = 0;
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
      retryCountRef.current = 0;

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
