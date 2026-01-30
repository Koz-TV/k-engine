#!/usr/bin/env node
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const cmd = process.argv[2];          // build | serve
const map = { build: 'build.js', serve: 'serve.js' };

if (!map[cmd]) {
  console.log('Usage: k-engine <build|serve>');
  process.exit(cmd ? 1 : 0);
}

spawn(
  process.execPath,
  [resolve(__dirname, map[cmd]), ...process.argv.slice(3)],
  { stdio: 'inherit' }
).on('exit', code => process.exit(code)); 