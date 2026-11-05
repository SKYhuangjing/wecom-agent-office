// Built-in outbound middleware (DESIGN §6.2): every message leaving the
// system toward a channel passes maskOutbound so a leaked API key never
// reaches a chat. The pattern targets provider secret shapes:
//   - sk/pk prefixes REQUIRE a '_'/'-' separator;
//   - 'Bearer' accepts '.', '_', '-' or whitespace (the HTTP wire format is
//     'Bearer <token>' with a space — the primary real-world leak shape);
//   - the leading (?<![A-Za-z0-9_-]) boundary stops mid-word matches
//     ('task-0123456789abcdef' contains 'sk-…' but must NOT be masked);
//   - case-insensitive: SK-/Pk-/bearer leak just as hard.
// Accepted trade-off: a 16+ char body with NO separator after sk/pk
// ('skABCDEFGHIJKLMNOP') is left as-is — the mandatory separator is what
// makes the boundary guard work; real provider tokens always carry one.
const SECRET = /(?<![A-Za-z0-9_-])(?:(?:sk|pk)[_-]|Bearer(?:[_.-]|\s+))[A-Za-z0-9_-]{16,}/gi;

// NOTE on the module-level /g regex: String#replace resets a global regex's
// lastIndex before and after the call, so sharing this one object is safe
// HERE. Do not reuse SECRET with .test()/.exec() — those advance lastIndex
// and would silently skip matches on later calls.
export function maskOutbound(text) {
  // Non-strings (engine may pass a null finalText) pass through untouched —
  // masking is a text transform, not a type gate.
  if (typeof text !== 'string') return text;
  return text.replace(SECRET, '***');
}
