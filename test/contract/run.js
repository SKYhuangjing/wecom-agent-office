#!/usr/bin/env node
// Provider port contract suite CLI (Task 16) — standalone runner, exit 0/1
// (deliberately NOT under the npm test glob: it asserts process semantics
// with real spawned children and takes seconds, not the ms-scale unit grid).
//
//   npm run contract                                  # → plugins/_template/provider (reference impl)
//   npm run contract -- --plugin plugins/provider-dsh # → Task 18 target, all groups
//   node test/contract/run.js --plugin <dir> [--port <portId>]
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runContractSuite } from './provider.contract.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const pluginDir = resolve(REPO, flag('--plugin') ?? 'plugins/_template/provider');
const providerId = flag('--port') ?? null;

const out = await runContractSuite({ pluginDir, providerId });

console.log(`contract: plugin ${pluginDir}${out.portId ? ` (port '${out.portId}')` : ''}`);
if (out.profileNote) console.log(`profile: ${out.profileNote}`);
for (const r of out.results) {
  const line = `${r.status.toUpperCase().padEnd(4)} ${r.id.padEnd(15)} ${r.name}`;
  console.log(r.detail ? `${line} — ${r.detail}` : line);
}
console.log(`${out.pass} passed, ${out.fail} failed, ${out.skip} skipped`);
process.exit(out.fail > 0 ? 1 : 0);
