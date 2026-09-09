// MOVED VERBATIM from routes/attachments.ts @ 328dea8 (UNSAFE_INLINE :7 + the inline
// filename sanitizer :74) — one source for REST and the MCP `get_attachment_content` tool.
// spec §10: never render HTML/SVG from attachment origin
export const UNSAFE_INLINE = /^text\/html|^application\/xhtml|^image\/svg/i

// filename sanitized for the disposition header: EVERY control char (\x00-\x1f, \x7f —
// node's header validator rejects anything outside \t\x20-\x7e\x80-\xff with a raw
// ERR_INVALID_CHAR 500) plus quote and backslash, all folded to '_'
export const safeFilename = (filename: string): string =>
  filename.replace(/[\x00-\x1f\x7f"\\]/g, '_')
