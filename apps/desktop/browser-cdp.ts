/// <reference types="electron" />
/**
 * 浏览器工具宿主层（CDP）
 * ----------------------------------------------------------------------------
 * 用 Electron 自带的 `webContents.debugger`（Chrome DevTools Protocol 1.3）
 * 驱动一个内置 BrowserWindow，**不引入 playwright / puppeteer**（ADR-0011）。
 *
 * 为什么走 CDP 而不是 `webContents.executeJavaScript`：
 *   1. Runtime.evaluate 支持 awaitPromise / returnByValue / userGesture / 超时，
 *      executeJavaScript 全都没有（填表后等异步校验只能靠 sleep）；
 *   2. 不受页面 CSP 与 `window.` 上下文污染影响；
 *   3. 截图 / 整页截图 / 导航等待是同一套协议，不必混用两套机制。
 *
 * 为什么是**共享登录态**的普通 session：浏览京东后台、内部系统等真实场景
 * 依赖用户已有的登录态；用独立 session 会让工具「能开网页但没有权限」，
 * 直接把能力砍掉一半。代价是 Agent 能看到用户已登录的页面 —— 因此所有
 * 会改变页面状态的操作（点击 / 输入 / 执行脚本）都必须过授权门（门在 main.ts）。
 *
 * 本模块只做「怎么驱动浏览器」，参数校验与表达式构造在 browser-tools.ts（纯逻辑）。
 */

import { BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BROWSER_NO_ELEMENT,
  BROWSER_SHOT_DIR,
  browserShotRelativePath,
  type BrowserStateSnapshot,
  type BrowserWaitMode,
} from './browser-tools';

/** CDP 协议版本：Electron 全系支持 1.3。 */
const CDP_VERSION = '1.3';

const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 900;

let win: BrowserWindow | null = null;
let attached = false;
let shotSeq = 0;
let lastShot: { path: string; dataUrl?: string } | null = null;
let lastError = '';
let stateListener: ((st: BrowserStateSnapshot) => void) | null = null;

export function onBrowserStateChange(cb: ((st: BrowserStateSnapshot) => void) | null): void {
  stateListener = cb;
}

export function isBrowserOpen(): boolean {
  return !!win && !win.isDestroyed();
}

export function getBrowserState(): BrowserStateSnapshot {
  // 未打开时也要给出 lastShot: null —— 状态对象形状必须稳定，
  // 否则渲染层要用 `st.lastShot || null` 之类的兜底才能不显示上一张截图。
  if (!isBrowserOpen() || !win) return { open: false, lastShot: null, lastError: lastError || undefined };
  return {
    open: true,
    url: win.webContents.getURL() || '',
    title: win.webContents.getTitle() || '',
    visible: win.isVisible(),
    lastShot,
    lastError: lastError || undefined,
  };
}

function emit(): void {
  if (stateListener) {
    try { stateListener(getBrowserState()); } catch { /* 推送失败不影响工具执行 */ }
  }
}

/** 取 debugger（调用前必须确认窗口存在）。 */
function dbg(): Electron.Debugger {
  return win!.webContents.debugger;
}

async function cdp<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> {
  if (!isBrowserOpen()) throw new Error('浏览器未打开');
  const d = dbg();
  if (!attached) {
    try {
      d.attach(CDP_VERSION);
      attached = true;
      // 视口固定：截图尺寸与元素可见范围才可预期（失败只影响截图，不阻断）。
      await d.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: WINDOW_WIDTH, height: WINDOW_HEIGHT, deviceScaleFactor: 1, mobile: false,
      }).catch(() => undefined);
    } catch (err) {
      throw new Error(`CDP 连接失败：${(err as Error).message}`);
    }
  }
  return (await d.sendCommand(method, params)) as T;
}

/** 创建（或复用）浏览器窗口。默认后台隐藏，用户可从「浏览器」面板显示它。 */
function ensureWindow(): BrowserWindow {
  if (isBrowserOpen()) return win!;
  attached = false;
  lastShot = null;
  lastError = '';
  const w = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: false,
    title: 'OrchDesk 浏览器',
    backgroundColor: '#FFFFFF',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // 不启用 offscreen：OSR 下截图与渲染在部分显卡驱动上有兼容问题，
      // 隐藏窗口（show:false）已足够，且可随时 show() 给用户看。
      offscreen: false,
    },
  });
  w.on('closed', () => {
    if (win === w) { win = null; attached = false; }
    emit();
  });
  win = w;
  return w;
}

/**
 * 等待页面加载。
 * 事件（Page.loadEventFired / Page.domContentEventFired）为主，
 * readyState 轮询为兜底：页面在 attach 之前就已加载完时，事件不会再发一次。
 */
async function waitForLoad(timeoutMs: number, mode: BrowserWaitMode): Promise<void> {
  const events = mode === 'dom'
    ? ['Page.domContentEventFired', 'Page.loadEventFired']
    : ['Page.loadEventFired'];
  const wantReady = mode === 'dom' ? ['interactive', 'complete'] : ['complete'];

  let settled = false;
  let timer: NodeJS.Timeout | null = null;
  let poll: NodeJS.Timeout | null = null;
  let resolveOuter: () => void = () => undefined;

  const msgHandler = (_e: unknown, method: string): void => {
    if (settled) return;
    if (events.includes(method)) { settled = true; cleanup(); resolveOuter(); }
  };

  // cleanup 里引用的三个句柄都在下面赋值；实际调用只发生在赋值之后（定时器 / 事件回调）。
  function cleanup(): void {
    if (timer) { clearTimeout(timer); timer = null; }
    if (poll) { clearInterval(poll); poll = null; }
    try {
      (dbg() as unknown as { removeListener: (e: string, fn: unknown) => void }).removeListener('message', msgHandler);
    } catch { /* 窗口已关闭 */ }
  }

  const result = new Promise<void>((resolve, reject) => {
    resolveOuter = resolve;
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`页面加载超时（${timeoutMs}ms）；可加大 timeout 或改用 waitUntil:"dom"`));
    }, timeoutMs);
  });

  // debugger 的所有 CDP 事件都走同一个 'message'，method 在第二个参数里。
  dbg().on('message', msgHandler);

  // 兜底轮询：evaluate 在导航期间可能抛错（执行上下文销毁），忽略即可。
  poll = setInterval(() => {
    if (settled) return;
    cdp<{ result?: { value?: unknown } }>('Runtime.evaluate', {
      expression: 'document.readyState', returnByValue: true,
    }).then((r) => {
      if (settled) return;
      const rs = String(r?.result?.value ?? '');
      if (wantReady.includes(rs)) { settled = true; cleanup(); resolveOuter(); }
    }).catch(() => undefined);
  }, 250);

  return result;
}

/** 打开（或导航到）网址。 */
export async function openBrowser(
  url: string,
  opts: { waitUntil?: BrowserWaitMode; timeoutMs?: number } = {},
): Promise<BrowserStateSnapshot> {
  const timeoutMs = opts.timeoutMs || 20_000;
  const mode = opts.waitUntil || 'load';
  ensureWindow();
  try {
    await cdp('Page.enable');
    await cdp('Runtime.enable');
  } catch (err) {
    lastError = (err as Error).message;
    emit();
    throw err;
  }

  const navPromise = cdp('Page.navigate', { url });
  const loadPromise = waitForLoad(timeoutMs, mode);
  try {
    await Promise.all([navPromise, loadPromise]);
  } catch (err) {
    // loadEventFired 超时但 navigate 本身成功时，页面其实是可用的：
    // 不把「等太久」当成「打不开」——保留窗口，把超时如实报给模型。
    await navPromise.catch(() => undefined);
    lastError = (err as Error).message;
    emit();
    throw err;
  }
  lastError = '';
  emit();
  return getBrowserState();
}

/** 在页面上下文求值。返回 { ok, value, error }。 */
export async function evalInPage(expression: string, timeoutMs = 10_000): Promise<{ ok: boolean; value?: string; error?: string }> {
  if (!isBrowserOpen()) return { ok: false, error: '浏览器未打开（先用 browser_open 打开网址）' };
  try {
    const r = await cdp<{
      result?: { value?: unknown; type?: string; subtype?: string; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      timeout: timeoutMs,
    });
    if (r.exceptionDetails) {
      const msg = r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面内执行异常';
      return { ok: false, error: String(msg).slice(0, 1000) };
    }
    const v = r.result?.value;
    const text = v === undefined || v === null
      ? (r.result?.type === 'undefined' ? '(undefined)' : '(null)')
      : typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    if (String(text).startsWith(BROWSER_NO_ELEMENT)) {
      return { ok: false, error: '选择器没有匹配到任何元素（可用 browser_text 先看页面结构，或换一个选择器）' };
    }
    return { ok: true, value: String(text) };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 1000) };
  }
}

/**
 * 截图：PNG 落盘（给模型绝对路径）+ 一张 JPEG 缩略图（给 UI 面板，data URL 不落盘）。
 * @param dataDir 数据根目录（screenshot 只在其中写 browser-shots 子目录）
 */
export async function screenshotBrowser(
  opts: { fullPage?: boolean } = {},
  dataDir?: string,
): Promise<{ ok: boolean; path?: string; dataUrl?: string; error?: string }> {
  if (!isBrowserOpen()) return { ok: false, error: '浏览器未打开（先用 browser_open 打开网址）' };
  if (!dataDir) return { ok: false, error: '数据目录未就绪' };
  try {
    const shot = await cdp<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: Boolean(opts.fullPage),
    });
    if (!shot?.data) return { ok: false, error: '截图返回空数据' };
    const ts = Date.now();
    shotSeq += 1;
    const rel = browserShotRelativePath(ts, shotSeq, 'png');
    const abs = path.join(dataDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(shot.data, 'base64'));

    let dataUrl: string | undefined;
    try {
      const thumb = await cdp<{ data: string }>('Page.captureScreenshot', {
        format: 'jpeg', quality: 45, captureBeyondViewport: false,
      });
      if (thumb?.data) dataUrl = `data:image/jpeg;base64,${thumb.data}`;
    } catch { /* 缩略图失败不影响主结果 */ }

    lastShot = { path: abs, dataUrl };
    lastError = '';
    emit();
    return { ok: true, path: abs, dataUrl };
  } catch (err) {
    const msg = (err as Error).message;
    lastError = msg;
    emit();
    return { ok: false, error: msg.slice(0, 500) };
  }
}

/** 显示 / 隐藏浏览器窗口（用户想看 Agent 在干什么时用）。 */
export function setBrowserVisible(visible: boolean): BrowserStateSnapshot {
  if (!isBrowserOpen() || !win) return getBrowserState();
  if (visible) {
    win.show();
    win.focus();
  } else {
    win.hide();
  }
  emit();
  return getBrowserState();
}

/** 关闭浏览器窗口（detach + 关闭；登录态保留在用户数据目录）。 */
export function closeBrowser(): boolean {
  if (!isBrowserOpen() || !win) return false;
  try {
    if (attached) {
      try { dbg().detach(); } catch { /* 可能已被页面侧断开 */ }
    }
  } finally {
    attached = false;
    const w = win;
    win = null;
    lastShot = null;
    try { w.close(); } catch { /* 已关闭 */ }
  }
  emit();
  return true;
}

/** 截图目录（数据目录 + browser-shots），供「打开截图目录」用。 */
export function browserShotDir(dataDir: string): string {
  return path.join(dataDir, BROWSER_SHOT_DIR);
}
