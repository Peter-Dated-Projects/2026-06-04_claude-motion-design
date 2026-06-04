import { useEffect, useLayoutEffect, useRef, useState } from "react";
import MessageBubble from "./MessageBubble";
import type { Message } from "../../types";
import "./ChatPanel.css";

// Presentational chat panel. The Claude conversation (useClaude) is owned by the
// parent (App) so the integration layer can drive the full loop -- generated code,
// auto-save, error toasts, the Escape-to-cancel shortcut -- from one place. This
// component just renders the transcript and the composer.
interface ChatPanelProps {
  messages: Message[];
  /** Live assistant text accumulating during a run (before it is finalized). */
  streamingText: string;
  isGenerating: boolean;
  /** True between send and the first streamed token. */
  isWaiting: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
  /** Disabled (with a hint) when there is no open project to chat against. */
  disabled?: boolean;
}

function ChatPanel({
  messages,
  streamingText,
  isGenerating,
  isWaiting,
  onSend,
  onCancel,
  disabled = false,
}: ChatPanelProps) {
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const hasConversation = messages.length > 0 || isGenerating;

  // Auto-scroll to the newest content as messages arrive or stream in.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamingText, isWaiting]);

  // Auto-grow the textarea up to a cap.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [input]);

  const submit = () => {
    if (isGenerating || disabled) return;
    const text = input.trim();
    if (!text) return;
    setInput("");
    onSend(text);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter or Cmd/Ctrl+Enter sends; Shift+Enter inserts a newline.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
      e.preventDefault();
      submit();
      return;
    }
    // Escape cancels an in-flight generation.
    if (e.key === "Escape" && isGenerating) {
      e.preventDefault();
      onCancel();
    }
  };

  const placeholder = disabled
    ? "Open or create a project to start..."
    : "Describe an animation...";

  return (
    <section className="panel panel--chat chatpanel">
      <div className="chatpanel__messages" ref={listRef}>
        {!hasConversation ? (
          <div className="chatpanel__empty">
            Describe an animation to get started...
          </div>
        ) : (
          <>
            {messages.map((m, i) => (
              <MessageBubble key={i} role={m.role} content={m.content} />
            ))}
            {isGenerating && isWaiting && (
              <div className="msg msg--assistant">
                <div className="msg__bubble">
                  <span className="chatpanel__ellipsis" aria-label="Claude is thinking">
                    <span />
                    <span />
                    <span />
                  </span>
                </div>
              </div>
            )}
            {isGenerating && !isWaiting && streamingText && (
              <MessageBubble role="assistant" content={streamingText} streaming />
            )}
          </>
        )}
      </div>

      <div className="chatpanel__composer">
        <textarea
          ref={textareaRef}
          className="chatpanel__input"
          placeholder={placeholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={isGenerating || disabled}
          rows={1}
        />
        {isGenerating ? (
          <button
            type="button"
            className="chatpanel__btn chatpanel__btn--stop"
            onClick={onCancel}
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="chatpanel__btn chatpanel__btn--send"
            onClick={submit}
            disabled={!input.trim() || disabled}
          >
            Send
          </button>
        )}
      </div>
    </section>
  );
}

export default ChatPanel;
