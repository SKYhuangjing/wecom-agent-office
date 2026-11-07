// Cross-platform CLI spawn for the provider runners (P1 跨平台).
// WHY a Windows branch at all: npm installs CLI package bin entries on
// Windows as `.cmd` batch shims, and node's spawn() REFUSES to execute
// batch files without a shell — hard EINVAL, the behavior shipped as the
// CVE-2024-27980 fix (cmd.exe argument injection; .bat/.cmd through spawn
// now requires an explicit shell). So on Windows the command is routed
// through cmd.exe (`shell: true`), which makes the npm shim runnable.
// The price: the command line becomes ONE string parsed TWICE (cmd.exe's
// own pass, then the target's MSVCRT argv split), so every argument must be
// escaped for both passes or a prompt containing spaces/quotes/& breaks the
// line — or executes as commands. Known inherited limit (same as
// cross-spawn): `%VAR%` expansion is not neutralized and a raw newline
// cannot ride a cmd line at all; provider prompts that carry newlines ride
// argv on claude/pi, so multi-line prompt text is the residual Windows gap
// (single-user loopback service: operator-controlled input, not attacker).
import { spawn } from 'node:child_process';
import process from 'node:process';

export const isWindows = process.platform === 'win32';

// cmd.exe-safe argument escaping (the cross-spawn algorithm, qntm.org/cmd):
//   1. backslash-escape embedded double quotes for the target's argv
//      re-parse (2n backslashes before a quote → n + escaped quote),
//   2. wrap the whole token in quotes,
//   3. ^-escape every cmd metacharacter — including the quotes themselves
//      and spaces — so cmd's own pass cannot reinterpret them; cmd consumes
//      the carets, the target receives the clean quoted token.
export const winArg = (a) => {
  let s = String(a);
  s = s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  s = `"${s}"`;
  return s.replace(/([()%!^"`<>&|;, *?])/g, '^$1');
};

// spawn(bin, args) that is a byte-identical passthrough on POSIX and goes
// through cmd.exe on Windows. The Windows branch builds ONE pre-escaped
// command string: node's shell:true arg joining does NOT quote, so the
// quoting must happen here, not at the call sites.
export function spawnCli(bin, args, { cwd, env, stdio = ['pipe', 'pipe', 'pipe'] } = {}) {
  if (isWindows) return spawn([bin, ...args].map(winArg).join(' '), { cwd, env, shell: true, stdio });
  return spawn(bin, args, { cwd, env, stdio });
}
