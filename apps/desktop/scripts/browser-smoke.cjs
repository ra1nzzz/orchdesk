/**
 * 浏览器工具「真机冒烟」——必须在真实 Electron 桌面会话里跑，不属于 npm run verify。
 *
 * 为什么不进 verify 链：
 *   browser-tools-verify.cjs 用 stub electron 驱动真实 dist/main.js，能证明「命令发出去了、
 *   门没开时不下发、截图落盘路径对」，但证明不了真机上 debugger.attach / Page.navigate /
 *   Runtime.evaluate / Page.captureScreenshot 真能跑通。这一步只有真 Chromium 能回答，
 *   而真 Chromium 需要可用的 GPU/渲染进程 —— CI 与非交互会话里没有，硬塞进 verify
 *   只会得到一个环境噪音导致的假红。
 *
 * 跑法（在桌面会话的终端里，从 apps/desktop 目录）：
 *   pnpm run smoke:browser
 *   # 等价：./node_modules/.bin/electron scripts/browser-smoke.cjs
 *
 * 两个必踩的坑（都写成了启动期的显式报错，别再浪费第二次）：
 *   1. ELECTRON_RUN_AS_NODE=1（从 Electron 宿主应用继承而来时很常见）会让 electron.exe
 *      退化成纯 Node，require('electron') 返回一个路径字符串，app 为 undefined。
 *   2. 脚本必须放在 apps/desktop 下，否则 require('electron') 解析不到 node_modules。
 *
 * 退出码：0 全绿 / 1 有 FAIL / 2 环境不对（不是 Electron 主进程）/ 3 整体超时。
 */
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

if (process.type !== 'browser') {
  console.error(
    '[browser-smoke] 当前不是 Electron 主进程（process.type=' + String(process.type) + '）。\n'
    + '多半是环境变量 ELECTRON_RUN_AS_NODE 把 electron.exe 变成了纯 Node。\n'
    + '请用：env -u ELECTRON_RUN_AS_NODE electron scripts/browser-smoke.cjs\n'
    + '或（PowerShell）：Remove-Item Env:ELECTRON_RUN_AS_NODE; pnpm run smoke:browser'
  );
  process.exit(2);
}

const { app } = require('electron');

// 这些 require 必须发生在确认是 Electron 主进程之后
const APP_DIR = path.resolve(__dirname, '..');
const cdp = require(path.join(APP_DIR, 'dist', 'browser-cdp.js'));
const bt = require(path.join(APP_DIR, 'dist', 'browser-tools.js'));

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>OrchDesk 冒烟页</title></head>'
  + '<body><h1 id="h">hello orchdesk</h1>'
  + '<input id="q" value="">'
  + '<a href="https://example.com/1">链接一</a>'
  + '<a href="https://example.com/2">链接二</a></body></html>';

const HARD_TIMEOUT_MS = 90000;
let server = null;
const out = [];
const step = (name, ok, extra) => out.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);

const hardTimer = setTimeout(() => {
  out.push('FAIL 冒烟整体超时（90s）——真机上通常是导航卡住或 GPU 进程崩溃');
  finish(3);
}, HARD_TIMEOUT_MS);

function finish(code) {
  clearTimeout(hardTimer);
  try { if (server) server.close(); } catch (_) { /* ignore */ }
  const failed = out.filter((l) => l.startsWith('FAIL')).length;
  console.log('\n=== BROWSER SMOKE ===\n' + out.join('\n') + `\n结果：${out.length - failed}/${out.length}\n`);
  app.exit(code !== undefined ? code : (failed ? 1 : 0));
}

app.whenReady().then(async () => {
  let url = '';
  try {
    // 0) 本地测试页：不依赖外网，结果可复现
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}/`;

    // 1) 导航：真发 Page.navigate 并等 load
    const st = await cdp.openBrowser(url, { waitUntil: 'load', timeoutMs: 20000 });
    step('browser_open 导航到本地测试页', st.open && st.url === url, JSON.stringify(st));

    // 2) 读正文（Runtime.evaluate + returnByValue）
    const text = await cdp.evalInPage(bt.buildTextExpression('', 500));
    step('browser_text 取到正文', text.ok && /hello orchdesk/.test(String(text.value)), String(text.value).slice(0, 120));

    // 3) 取链接
    const links = await cdp.evalInPage(bt.buildLinksExpression('', 10));
    step('browser_links 取到两个链接', links.ok && /example\.com\/1/.test(String(links.value)) && /example\.com\/2/.test(String(links.value)), String(links.value).slice(0, 160));

    // 4) 填值 + 回读：验证 JSON.stringify 注入没有把引号/反斜杠弄坏
    const typed = await cdp.evalInPage(bt.buildTypeExpression('#q', 'he said "hi" \\ ok', { clear: true, pressEnter: false }));
    step('browser_type 填值返回成功', typed.ok, JSON.stringify(typed).slice(0, 160));
    const readBack = await cdp.evalInPage('document.querySelector("#q").value');
    step('browser_type 值回读（引号/反斜杠不逃逸）', String(readBack.value) === 'he said "hi" \\ ok', JSON.stringify(readBack.value));

    // 5) 点击：命中要成功，缺失元素必须报错而不是静默成功
    const clicked = await cdp.evalInPage(bt.buildClickExpression('#h'));
    step('browser_click 命中元素', clicked.ok, JSON.stringify(clicked).slice(0, 160));
    const missing = await cdp.evalInPage(bt.buildClickExpression('#nope'));
    step('browser_click 缺失元素报错（不静默成功）', !missing.ok, JSON.stringify(missing).slice(0, 160));

    // 6) 截图：PNG 真落盘 + 缩略图 dataUrl
    const shot = await cdp.screenshotBrowser({}, app.getPath('userData'));
    const size = shot.ok && fs.existsSync(shot.path) ? fs.statSync(shot.path).size : 0;
    step('browser_screenshot PNG 落盘', shot.ok && size > 1000, `${shot.path} size=${size} thumb=${!!shot.dataUrl}`);

    // 7) 状态里带 lastShot；关闭后归零
    const st2 = cdp.getBrowserState();
    step('状态带 lastShot', !!(st2.open && st2.lastShot && st2.lastShot.path), JSON.stringify({ open: st2.open, shot: st2.lastShot && st2.lastShot.path }));
    cdp.closeBrowser();
    const st3 = cdp.getBrowserState();
    step('browser_close 后 open=false 且 lastShot=null', st3.open === false && st3.lastShot === null, JSON.stringify(st3));
  } catch (err) {
    step('冒烟过程抛异常', false, (err && err.stack) || String(err));
  }
  finish();
}).catch((err) => {
  step('whenReady 失败', false, (err && err.stack) || String(err));
  finish();
});
