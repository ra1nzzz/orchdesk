/**
 * 版本守卫（SemVer 治理的机器执行）
 * ----------------------------------------------------------------------------
 * 规则：打包产物的版本号必须与最新 git tag 不同 —— 禁止在已发布版本号上重复打包。
 *   - dist / dist:win / dist:portable 前置调用（严格模式）：version == 最新 tag → 阻断，
 *     提示先 `npm run version:bump`
 *   - release 流程传 --allow-tagged：仅当最新 tag 恰好指向当前 HEAD（bumpp 刚打的
 *     正式发布 tag）时放行；tag 指向别的提交仍然阻断
 * 仓库无任何 tag（首次构建）放行。
 */
const { execSync } = require('node:child_process');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const allowTagged = process.argv.includes('--allow-tagged');
const pkg = require(path.join(APP_DIR, 'package.json'));

function git(cmd) {
  return execSync(cmd, { cwd: APP_DIR }).toString().trim();
}

let latest = '';
try {
  latest = git('git describe --tags --abbrev=0');
} catch {
  console.log('[version-guard] 仓库尚无 tag，放行（首次构建）');
  process.exit(0);
}

if (latest !== `v${pkg.version}`) {
  console.log(`[version-guard] OK：package.json ${pkg.version} ≠ 最新 tag ${latest}`);
  process.exit(0);
}

// version == 最新 tag：检查是否为「刚打完 tag 的正式发布」场景
if (allowTagged) {
  try {
    const tagHead = git(`git rev-list -1 ${latest}`);
    const head = git('git rev-parse HEAD');
    if (tagHead === head) {
      console.log(`[version-guard] OK（release）：${latest} 指向当前 HEAD，允许正式发布构建`);
      process.exit(0);
    }
    console.error(`[version-guard] ${latest} 指向 ${tagHead.slice(0, 8)}，而 HEAD 是 ${head.slice(0, 8)} —— 请先 version:bump`);
    process.exit(1);
  } catch (err) {
    console.error('[version-guard] 解析 tag 指向失败:', (err && err.message) || err);
    process.exit(1);
  }
}

console.error(
  `[version-guard] 禁止在同一版本号上重复打包：package.json=${pkg.version} 与最新 tag ${latest} 相同。\n` +
  '  请先递增版本（SemVer：feat→minor / fix→patch）：npm run version:bump',
);
process.exit(1);
