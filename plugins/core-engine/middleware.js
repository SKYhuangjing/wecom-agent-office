// Built-in outbound middleware (DESIGN §6.2): every message leaving the
// system toward a channel passes maskOutbound so a leaked API key never
// reaches a chat. The pattern targets provider secret shapes — an sk/pk/Bearer
// prefix, optional separator, then a 16+ char token body — replaced wholesale
// with '***' (case-insensitive: SK-/Pk-/bearer leak just as hard).
//
// Known gaps, deliberate per the task spec's exact pattern (flagged for the
// engine-wiring task): a SPACE after Bearer (the HTTP wire format) is not in
// the separator class, and long identifiers merely containing sk/pk (e.g.
// 'task-0123456789abcdef') can match — the engine should mask before composing
// URLs/identifiers into human text if that becomes a real leak vector.
const SECRET = /(sk|pk|Bearer)[_-]?[A-Za-z0-9_\-]{16,}/gi;

export function maskOutbound(text) {
  // Non-strings (engine may pass a null finalText) pass through untouched —
  // masking is a text transform, not a type gate.
  if (typeof text !== 'string') return text;
  // A fresh RegExp object per evaluation of the literal, so /g lastIndex
  // state never leaks between calls.
  return text.replace(SECRET, '***');
}
