// Bundle proj4 at a git ref: node bench/build-ref.mjs <ref> <out.js>
import { execFileSync } from 'child_process';
import { copyFileSync, mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const [ref, out] = process.argv.slice(2);
if (!ref || !out) {
  console.error('usage: node bench/build-ref.mjs <ref> <out.js>');
  process.exit(1);
}
const root = resolve(import.meta.dirname, '..');
const dir = join(mkdtempSync(join(tmpdir(), 'proj4-bench-')), 'tree');
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] });
try {
  run('git', ['worktree', 'add', '--detach', dir, ref], root);
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
  run('node', ['scripts/build.mjs'], dir);
  run('npx', ['rollup', '-c'], dir);
  copyFileSync(join(dir, 'dist/proj4-src.js'), resolve(out));
  console.log(ref, '->', out);
} finally {
  run('git', ['worktree', 'remove', '--force', dir], root);
  rmSync(resolve(dir, '..'), { recursive: true, force: true });
}
