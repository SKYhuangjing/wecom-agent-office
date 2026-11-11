// code-guard outbound middleware (PLUGIN-DEV §5.5 chain port, cost-tracker
// precedent): strips CODE from the bot's FINAL WeCom reply when the bot opts
// in via providerConfig.codeGuard === true. Answer-style bots (运价/客服 Sky)
// never owe colleagues code — the 2026-11-11 blind review proved the prompt
// layer alone can't hold that line on every sample (deepseek-flash pasted a
// full crawler template 2/5 runs, and once bypassed the "no code in reply"
// rule by writing the script INTO the source tree). Tool exclusion
// (--exclude-tools write,edit) closed the file route; THIS guard closes the
// text route at the one choke point every channel reply passes through.
//
// Policy (deliberately narrow — over-blocking is worse than the leak):
//   - fenced blocks tagged with a programming language → always stripped;
//   - UNTAGGED fences → stripped only on a strong code signal
//     (def/class/import/function/const/func/#include/… at line starts);
//   - json fences and bare non-code fences (quoted logs, tables, plain
//     text) pass through untouched.
// Replacement copy states the policy in business language; no reply is ever
// emptied — the surrounding business text stays.

// Lower-cased fence tags that unambiguously mean code.
export const CODE_LANGS = new Set([
  'python', 'py', 'javascript', 'js', 'typescript', 'ts', 'jsx', 'tsx',
  'java', 'go', 'rust', 'rs', 'c', 'cpp', 'c++', 'csharp', 'cs', 'php',
  'ruby', 'rb', 'swift', 'kotlin', 'scala', 'bash', 'sh', 'shell', 'zsh',
  'powershell', 'ps1', 'bat', 'cmd', 'console',
]);

// Strong code shape inside an untagged fence: any line STARTING like code.
const CODE_SIGNAL_RE = /^[ \t]*(?:def\s|class\s|from\s+\S+\s+import\s|import\s+[\w.]+\s|function\s*|const\s|let\s|var\s|func\s|fn\s|package\s|public\s|private\s|#include|using\s|require\s*\(|module\.exports|echo\s|printf\s)/m;

export const STRIP_NOTE = '（代码内容已略去——写代码类需求请找技术同事处理）';

// Fences: an opener ```[tag], body, then a closing ``` — or end-of-text for
// the truncated-tail case (an aborted run may leave the fence unclosed; the
// partial code inside must still not ship).
const FENCE_RE = /```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g;

// Pure rewrite: returns { text, stripped } — same string back when nothing
// matched. Never throws on non-string input (defensive, middleware contract).
export function stripCodeFences(text) {
  if (typeof text !== 'string' || !text.includes('```')) {
    return { text, stripped: 0 };
  }
  let stripped = 0;
  const out = text.replace(FENCE_RE, (whole, tag, body) => {
    const t = String(tag).trim().toLowerCase();
    if (CODE_LANGS.has(t) || (t === '' && CODE_SIGNAL_RE.test(body))) {
      stripped += 1;
      return STRIP_NOTE;
    }
    return whole;
  });
  return { text: out, stripped };
}

// createGuard({ isOn, log }) → { onOutbound(text, ctx) }. `isOn` defaults to
// off — a bare guard never rewrites text (tests embed explicit stubs).
export function createGuard({ isOn = () => false, log = null } = {}) {
  return {
    onOutbound(text, ctx) {
      if (!isOn(ctx?.bot)) return text; // bot-level toggle: off → unchanged
      try {
        const { text: out, stripped } = stripCodeFences(text);
        if (stripped > 0) {
          log?.info?.(`code-guard: stripped ${stripped} code block(s) from ${ctx?.bot?.id ?? 'bot'} reply`);
        }
        return out;
      } catch {
        return text; // a broken rewrite must never eat the reply
      }
    },
  };
}
