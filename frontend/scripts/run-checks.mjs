/**
 * 纯 Node 测试运行器：用 esbuild 把 TS 用例打成 CJS 后立即执行。
 * - ledger：棚时段账本纯规则（无需浏览器）
 * - db：Dexie v1→v2 升级 / 导入归一 / 抢账（fake-indexeddb）
 */
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { rm } from 'node:fs/promises';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const SUITES = {
  ledger: {
    entry: path.join(root, 'scripts/ledger-check.ts'),
    outfile: path.join(root, 'scripts/.ledger-check.cjs'),
    alias: {}
  },
  db: {
    entry: path.join(root, 'scripts/db-upgrade-check.ts'),
    outfile: path.join(root, 'scripts/.db-upgrade-check.cjs'),
    alias: { '@': path.join(root, 'src') }
  }
};

async function runSuite(name) {
  const suite = SUITES[name];
  await build({
    entryPoints: [suite.entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: suite.outfile,
    alias: suite.alias,
    logLevel: 'silent'
  });
  await import(pathToFileURL(suite.outfile).href + `?t=${Date.now()}`);
  await rm(suite.outfile, { force: true });
}

const target = process.argv[2] ?? 'all';
const names = target === 'all' ? Object.keys(SUITES) : [target];
if (names.some((name) => !(name in SUITES))) {
  console.error(`未知用例：${target}，可选 ledger / db / all`);
  process.exit(2);
}
for (const name of names) {
  console.log(`\n=== ${name} ===`);
  await runSuite(name);
}
