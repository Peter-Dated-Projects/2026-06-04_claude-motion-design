import { Fragment, type ReactNode } from "react";
import type { Message } from "../../types";

interface MessageBubbleProps {
  role: Message["role"];
  content: string;
  /** Marks the live, still-streaming assistant bubble (for a subtle caret). */
  streaming?: boolean;
}

// ---------------------------------------------------------------------------
// Tiny, dependency-free markdown rendering for assistant messages. We avoid
// pulling in react-markdown (not in package.json, and adding deps is out of
// scope for this ticket); this covers the cases Claude actually emits in chat:
// fenced code blocks, inline code, bold, and preserved line breaks.
// ---------------------------------------------------------------------------

/** Render inline spans: `code` and **bold**. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Split on inline code first so bold markers inside code are left untouched.
  const parts = text.split(/(`[^`]+`)/g);
  parts.forEach((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      nodes.push(
        <code key={`${keyPrefix}-c${i}`} className="msg__inline-code">
          {part.slice(1, -1)}
        </code>,
      );
      return;
    }
    // Bold: **text**
    const boldParts = part.split(/(\*\*[^*]+\*\*)/g);
    boldParts.forEach((bp, j) => {
      if (bp.startsWith("**") && bp.endsWith("**") && bp.length >= 4) {
        nodes.push(<strong key={`${keyPrefix}-b${i}-${j}`}>{bp.slice(2, -2)}</strong>);
      } else if (bp) {
        nodes.push(<Fragment key={`${keyPrefix}-t${i}-${j}`}>{bp}</Fragment>);
      }
    });
  });
  return nodes;
}

function renderMarkdown(content: string): ReactNode[] {
  const blocks: ReactNode[] = [];
  // Split into fenced code blocks vs. everything else.
  const segments = content.split(/(```[\s\S]*?```)/g);

  segments.forEach((seg, idx) => {
    if (seg.startsWith("```") && seg.endsWith("```")) {
      // Drop the opening fence (and optional language tag) and closing fence.
      const inner = seg.slice(3, -3).replace(/^[^\n]*\n/, "");
      blocks.push(
        <pre key={`pre-${idx}`} className="msg__code-block">
          <code>{inner.replace(/\n$/, "")}</code>
        </pre>,
      );
      return;
    }
    if (!seg) return;
    // Preserve paragraph breaks; render line breaks inside a paragraph.
    const lines = seg.split("\n");
    blocks.push(
      <p key={`p-${idx}`} className="msg__text">
        {lines.map((line, li) => (
          <Fragment key={`l-${li}`}>
            {renderInline(line, `${idx}-${li}`)}
            {li < lines.length - 1 && <br />}
          </Fragment>
        ))}
      </p>,
    );
  });

  return blocks;
}

function MessageBubble({ role, content, streaming }: MessageBubbleProps) {
  const isUser = role === "user";
  return (
    <div className={`msg msg--${role}`}>
      <div className="msg__bubble">
        {isUser ? (
          <p className="msg__text msg__text--plain">{content}</p>
        ) : (
          <div className="msg__markdown">
            {renderMarkdown(content)}
            {streaming && <span className="msg__caret" aria-hidden="true" />}
          </div>
        )}
      </div>
    </div>
  );
}

export default MessageBubble;
