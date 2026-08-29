/**
 * 验证脚本共享脚手架（零依赖）
 * ----------------------------------------------------------------------------
 * ponytail audit 削减项 #1：此前 5 个脚本各带一份 electron stub、10 个脚本各自
 * 实现一份 check()+计分样板 —— 同一份代码复制粘贴 N 遍。这里收口成两件东西：
 *
 *   makeElectronStub(opts)  electron 假实现
 *   createChecker()         check + 计分 + 汇总
 *
 * 设计取舍：
 * 1. stub 取 5 份旧实现的**并集**，不是各取所需。多余桩方法零维护成本（都在这一处），
 *    而缺一个方法就会让某个脚本失败——**桩要宽容，断言要严格**。
 * 2. 不做全参数化工厂（ponytail 反对为几个调用方堆配置项）：只把真正有分歧的两处
 *    （getPath 语义、whenReady 回调）做成 opts，其余差异让调用方直接覆盖属性，
 *     例如 `stub.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [F] })`。
 *
 * 用法（CJS）：const { makeElectronStub, createChecker } = require('../../scripts/verify-kit.cjs');
 * 用法（ESM）：import { makeElectronStub, createChecker } from './verify-kit.cjs';
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * electron 假实现。
 * @param {object} [opts]
 * @param {string} [opts.home]         数据根目录，缺省自建临时目录
 * @param {(name:string)=>string} [opts.getPath]  覆盖 app.getPath 语义
 * @param {()=>void} [opts.onReady]    whenReady 时的回调（dsh-runtime 用它 resolve 门控）
 * @param {object} [opts.safeStorage]  覆盖加解密桩（默认 `enc:` 前缀的可逆假加密）
 */
function makeElectronStub(opts = {}) {
  const home = opts.home || fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-stub-'));
  const ipcHandlers = new Map();
  const ipcListeners = new Map();
  /** 渲染层收到的所有 webContents.send（审批链路端到端测试用）。 */
  const webSent = [];

  return {
    home,
    ipcHandlers,
    ipcListeners,
    webSent,
    app: {
      isPackaged: false,
      name: 'OrchDesk',
      getPath: opts.getPath || ((name) => path.join(home, 'stub', String(name))),
      whenReady: () => { if (opts.onReady) setImmediate(opts.onReady); return Promise.resolve(); },
      on: () => {},
      quit: () => {},
    },
    ipcMain: {
      handle: (ch, fn) => { ipcHandlers.set(ch, fn); },
      on: (ch, fn) => { ipcListeners.set(ch, fn); },
    },
    BrowserWindow: class {
      constructor() { this.webContents = { send: (ch, payload) => { webSent.push({ ch, payload }); } }; this.destroyed = false; }
      isDestroyed() { return this.destroyed; }
      once() {}
      loadFile() {}
      show() {}
      static getAllWindows() { return []; }
    },
    Tray: class { setToolTip() {} setContextMenu() {} },
    Menu: { buildFromTemplate: () => ({}) },
    nativeImage: { createEmpty: () => ({}), createFromPath: () => ({}) },
    contextBridge: { exposeInMainWorld: () => {} },
    shell: { openPath: async () => '' },
    safeStorage: opts.safeStorage || {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('enc:' + s, 'utf-8'),
      decryptString: (b) => Buffer.from(b).toString('utf-8').replace(/^enc:/, ''),
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true, filePath: '' }),
    },
  };
}

/**
 * check + 计分 + 汇总。各脚本的输出尾缀不同，用 okTitle 传入。
 * @returns {{ check: Function, log: string[], passed: number, failed: number, summary: (okTitle?: string) => boolean }}
 */
function createChecker() {
  const log = [];
  let passed = 0;
  let failed = 0;

  const check = async (name, fn) => {
    try {
      await fn();
      passed++;
      log.push(`  PASS  ${name}`);
    } catch (err) {
      failed++;
      // 失败时附带一行栈帧：断言文案常不足以定位到具体行（吸收自 data-port-verify 的做法）
      const stackLine = err && err.stack ? err.stack.split('\n')[1] : '';
      log.push(`  FAIL  ${name}\n        ${(err && err.message) || err}${stackLine ? '\n        ' + stackLine.trim() : ''}`);
    }
  };

  return {
    check,
    log,
    get passed() { return passed; },
    get failed() { return failed; },
    /** 打印明细与汇总；返回是否全绿（调用方据此决定退出码）。 */
    summary(okTitle) {
      console.log('\n' + log.join('\n'));
      console.log(`\n结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项\n`);
      if (okTitle && failed === 0) console.log(okTitle);
      return failed === 0;
    },
  };
}

module.exports = { makeElectronStub, createChecker };
