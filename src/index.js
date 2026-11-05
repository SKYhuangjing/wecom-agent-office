#!/usr/bin/env node
// wao entry: start | doctor | version  (filled in by later tasks)
// package.json is read via URL (not cwd-relative) so `wao version` works from any directory;
// dynamic JSON import returns a namespace object which JSON.parse cannot consume.
import process from 'node:process';
import { readFileSync } from 'node:fs';
const cmd = process.argv[2] || 'start';
if (cmd === 'version') { console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version); }
else console.error('start/doctor arrive in later tasks'), process.exit(2);
