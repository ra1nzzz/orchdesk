/**
 * 文件 Tab —— 纯逻辑层（零 electron 依赖，可 node 直测）
 * ----------------------------------------------------------------------------
 * 产品定位（Minke 对照 P2）：只读优先的本地文件浏览与高亮预览，让用户能对照
 * 「Agent 改了什么 / 项目里有什么」。编辑与 diff（@codemirror/merge）等审阅
 * 场景成为刚需时再上（吸收计划 P3-17）。
 *
 * 本文件只负责「与运行环境无关」的部分，宿主 IPC 在 main.ts：
 *   1. 树参数归一化（目录深度 / 单目录条目上限 / 排序规则）
 *   2. 读取参数归一化（大小钳制、截断语义——「截断」必须显式，不许静默）
 *   3. 二进制嗅探（NUL 字节 + 扩展名双通道），二进制文件只给元信息不吐内容
 *   4. 语言探测（shiki 语法 id；探测不到 → 纯文本，渲染层不许猜）
 *
 * 安全口径：这是「用户亲手浏览自己机器」的 UI 入口，不走 Agent 授权门；
 * 但所有读取都限长、限深、限条目，防止一个巨大的目录把渲染层拖死。
 */

// ---------------------------------------------------------------------------
// 常量与钳制
// ---------------------------------------------------------------------------

/** 目录遍历上限：单目录最多列出的条目数（超出标记 truncated）。 */
export const FILE_TREE_MAX_ENTRIES = 500;

/** 目录递归深度上限（0 = 只列一层）。 */
export const FILE_TREE_MAX_DEPTH = 6;

/** 文件读取上限（字节）：超出截断并显式返回 truncated=true。 */
export const FILE_READ_MAX_BYTES = 2 * 1024 * 1024;

/** 文件名 / 路径长度上限（防病态输入）。 */
export const FILE_PATH_MAX = 2048;

/** 视为二进制的扩展名（嗅探的前置快通道，防大文件白读）。 */
export const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif',
  'mp3', 'wav', 'ogg', 'flac', 'mp4', 'webm', 'avi', 'mov', 'mkv',
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar',
  'exe', 'dll', 'so', 'dylib', 'node', 'pdb', 'wasm',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'db', 'sqlite', 'sqlite3', 'class', 'jar', 'pyc',
]);

/** 嗅探窗口：只看文件头 8KB。 */
export const SNIFF_WINDOW = 8192;

// ---------------------------------------------------------------------------
// 扩展名 / 语言
// ---------------------------------------------------------------------------

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

/** 判断是否可能为二进制（扩展名快通道；内容嗅探由宿主调 sniffBinary）。 */
export function looksBinaryByName(name: string): boolean {
  return BINARY_EXTENSIONS.has(extOf(name));
}

/**
 * 内容嗅探：前 8KB 里出现 NUL 字节即判定二进制。
 * （与 git 的 heuristic 同源：文本文件不会含 0x00。）
 */
export function sniffBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, SNIFF_WINDOW);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * 扩展名 → shiki 语言 id。探测不到返回 null（渲染层走纯文本，不许猜）。
 * 只收录 shiki 精简包里实际打包的语言，其余一律 null。
 */
const LANG_BY_EXT: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  json: 'json', jsonc: 'json',
  md: 'markdown', markdown: 'markdown',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html', vue: 'html', svg: 'xml', xml: 'xml',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini',
  sql: 'sql', php: 'php', lua: 'lua', swift: 'swift', kt: 'kotlin',
  txt: 'plaintext',
};

export function languageOf(name: string): string | null {
  return LANG_BY_EXT[extOf(name)] || null;
}

// ---------------------------------------------------------------------------
// 树参数与条目归一化
// ---------------------------------------------------------------------------

export type FileTreeArgs = { dir?: string; depth?: number | string };

export type NormalizedFileTree = { ok: true; dir: string; depth: number };
export type RejectedFileTree = { ok: false; reason: string };

export function normalizeFileTree(
  input: FileTreeArgs | undefined,
): NormalizedFileTree | RejectedFileTree {
  const src = input && typeof input === 'object' ? input : {};
  const dir = typeof src.dir === 'string' ? src.dir.trim() : '';
  if (dir === '') return { ok: false, reason: '缺少 dir' };
  if (dir.length > FILE_PATH_MAX) return { ok: false, reason: '路径过长' };
  if (!/^[a-zA-Z]:[\\/]/.test(dir) && !dir.startsWith('/')) {
    return { ok: false, reason: 'dir 必须是绝对路径' };
  }
  const depth = clampCount(src.depth, 1, FILE_TREE_MAX_DEPTH, 1);
  return { ok: true, dir, depth };
}

/** 文件读取参数归一化：路径形状 + 大小上限（宿主做存在性与 NUL 嗅探）。 */
export type FileReadArgs = { path?: string };
export type NormalizedFileRead = { ok: true; path: string; maxBytes: number };
export type RejectedFileRead = { ok: false; reason: string };

export function normalizeFileRead(
  input: FileReadArgs | undefined,
): NormalizedFileRead | RejectedFileRead {
  const src = input && typeof input === 'object' ? input : {};
  const p = typeof src.path === 'string' ? src.path.trim() : '';
  if (p === '') return { ok: false, reason: '缺少 path' };
  if (p.length > FILE_PATH_MAX) return { ok: false, reason: '路径过长' };
  if (!/^[a-zA-Z]:[\\/]/.test(p) && !p.startsWith('/')) {
    return { ok: false, reason: 'path 必须是绝对路径' };
  }
  return { ok: true, path: p, maxBytes: FILE_READ_MAX_BYTES };
}

function clampCount(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// ---------------------------------------------------------------------------
// 树排序与模型
// ---------------------------------------------------------------------------

export type RawEntry = {
  name: string;
  kind: 'file' | 'dir';
  size: number;
  mtime: number;
};

export type TreeEntry = RawEntry & { ext: string; binary: boolean };

/**
 * 目录条目排序：目录在前、名称不区分大小写升序。
 * 渲染层不做排序逻辑——宿主给什么渲染什么，行为才可测。
 */
export function sortTreeEntries(entries: RawEntry[]): TreeEntry[] {
  return entries
    .slice(0, FILE_TREE_MAX_ENTRIES)
    .map((e) => ({
      ...e,
      ext: e.kind === 'file' ? extOf(e.name) : '',
      binary: e.kind === 'file' ? looksBinaryByName(e.name) : false,
    }))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.toLowerCase() < b.name.toLowerCase()
        ? -1
        : a.name.toLowerCase() > b.name.toLowerCase()
          ? 1
          : 0;
    });
}

/**
 * 人类可读大小（渲染层直接展示，避免每处各写一个 formatter）。
 */
export function humanSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}
