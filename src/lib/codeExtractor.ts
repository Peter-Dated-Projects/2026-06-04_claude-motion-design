// Pull the generated TSX out of a Claude response.
//
// The system prompt instructs the model to wrap its entire output in a single
// <code> tag. We extract that. As a safety net, if the model ignored the contract
// but the response is plainly a TSX file (starts with an import), we accept it
// as-is. Anything else returns null so the caller can surface a parse failure
// rather than feeding prose to the esbuild validator.

const CODE_TAG = /<code>([\s\S]*?)<\/code>/

export function extractCode(response: string): string | null {
  const match = response.match(CODE_TAG)
  if (match) return match[1].trim()

  // Fallback: response looks like a raw TSX file.
  const trimmed = response.trim()
  if (trimmed.startsWith('import')) return trimmed

  return null
}
