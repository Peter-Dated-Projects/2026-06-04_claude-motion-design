// Client-side prompt assembly for the Claude bridge.
//
// The system prompt (remotion-skills.txt) carries all the standing rules and the
// output contract; this module assembles the per-turn user message. It wraps the
// current editor contents and the user's request in XML tags the model is told to
// expect, and — when the user has a region selected — annotates that region inline
// with <selection> tags so the model knows exactly what to act on.

export interface Selection {
  text: string
  /** 1-based, inclusive (Monaco line numbers). */
  startLine: number
  /** 1-based, inclusive. */
  endLine: number
}

export interface BuildPromptOptions {
  currentCode: string | null
  selection: Selection | null
  userRequest: string
}

/**
 * Insert <selection> / </selection> marker lines around the selected region of
 * `code`, identified by 1-based inclusive line numbers. Out-of-range bounds are
 * clamped so a stale selection can never throw or drop code.
 */
export function annotateSelection(code: string, selection: Selection): string {
  const lines = code.split('\n')
  const start = Math.max(1, Math.min(selection.startLine, lines.length))
  const end = Math.max(start, Math.min(selection.endLine, lines.length))

  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1 // 1-based
    if (lineNo === start) out.push('<selection>')
    out.push(lines[i])
    if (lineNo === end) out.push('</selection>')
  }
  return out.join('\n')
}

/**
 * Assemble the per-turn message sent to Claude: an optional <current_code> block
 * (with the active selection annotated inline) followed by the <user_request>.
 */
export function buildPrompt(opts: BuildPromptOptions): string {
  const parts: string[] = []

  if (opts.currentCode) {
    if (opts.selection) {
      const annotated = annotateSelection(opts.currentCode, opts.selection)
      parts.push(`<current_code>\n${annotated}\n</current_code>`)
    } else {
      parts.push(`<current_code>\n${opts.currentCode}\n</current_code>`)
    }
  }

  parts.push(`<user_request>\n${opts.userRequest}\n</user_request>`)

  return parts.join('\n\n')
}
