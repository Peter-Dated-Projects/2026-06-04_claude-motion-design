import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useClaude } from "../../hooks/useClaude";
import MessageBubble from "./MessageBubble";
import "./ChatPanel.css";

interface ChatPanelProps {
  /**
   * Routed to the editor by the parent (integration wiring) when Claude
   * produces a new animation, mirroring how CodePanel receives its `code`.
   */
  onCodeGenerated?: (code: string) => void;
}

function ChatPanel({ onCodeGenerated }: ChatPanelProps) {
  const { messages, streamingText, isGenerating, isWaiting, error, send, cancel } =
    useClaude({ onCodeGenerated });

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
    if (isGenerating) return;
    const text = input.trim();
    if (!text) return;
    setInput("");
    void send(text);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

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

      {error && <div className="chatpanel__error">{error}</div>}

      <div className="chatpanel__composer">
        <textarea
          ref={textareaRef}
          className="chatpanel__input"
          placeholder="Describe an animation..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={isGenerating}
          rows={1}
        />
        {isGenerating ? (
          <button
            type="button"
            className="chatpanel__btn chatpanel__btn--stop"
            onClick={() => void cancel()}
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="chatpanel__btn chatpanel__btn--send"
            onClick={submit}
            disabled={!input.trim()}
          >
            Send
          </button>
        )}
      </div>
    </section>
  );
}

export default ChatPanel;
