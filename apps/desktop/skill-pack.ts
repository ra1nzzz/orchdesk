/**
 * Skill 打包器 —— 零依赖 .skill（ZIP，STORE 无压缩）读写。
 * ----------------------------------------------------------------------------
 * 纯逻辑模块：**不 import electron**，可 node 直测（见 skill-pack-verify.cjs）。
 *
 * 为什么自己写 ZIP 而不是引 adm-zip / jszip：
 *   - 项目纪律「零依赖、纯逻辑可直测」——第三方 zip 库会带进 CRC/解压依赖树，
 *     且无法满足「STORE-only 就能覆盖 .skill 打包」这种极薄需求。
 *   - .skill 的真实格式（2026-08 用实际文件反推）：ZIP，**根目录 = `<slug>/SKILL.md`**
 *     （不是 SKILL.md 直接在 zip 根！观雅集/WorkBuddy 生态都是 <slug>/SKILL.md），
 *     可含 references/ scripts/ 等子目录。SKILL.md 顶部是 YAML frontmatter
 *     （name / description），分隔线 `---` 之后是正文。
 *   - 发布只需要「写」，用 STORE（无压缩）+ CRC32 即可——读（解压/校验）暂不需要
 *     （应用只管理 .skill 文件做上传/分发，不在此解压执行）。
 *
 * 输出可被系统 zipfile / 观雅集下载链正确识别（STORE 是合法 ZIP 方法）。
 */

// ============================================================================
// CRC32（ZIP 标准多项式 0xEDB88320）
// ============================================================================

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    if (byte == null) continue;
    c = (CRC_TABLE[(c ^ byte) & 0xFF] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ============================================================================
// 输入模型
// ============================================================================

/** 要写进 .skill 的单个文件（相对 zip 根；内部按 zipPath 存放，不改大小写）。 */
export interface SkillPackFile {
  /** zip 内路径，如 `promo-video/SKILL.md`、`promo-video/references/x.md`。 */
  zipPath: string;
  content: string;
}

/** 组装 .skill 的纯函数输入（不依赖磁盘）。 */
export interface AssembleSkillInput {
  /** slug：也是 zip 根目录名 + 落盘文件名。 */
  slug: string;
  description: string;
  /** SKILL.md 正文（不含 frontmatter；会自动包 name/description frontmatter）。 */
  body: string;
  /** 附加文件（references/scripts/…），zipPath 须以 `<slug>/` 开头。 */
  extra?: SkillPackFile[];
}

// ============================================================================
// 组装
// ============================================================================

/** 校验 slug（目录名白名单，与 guanji isMarketDirName 同纪律）。 */
export function isSkillSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && slug.length > 0 && slug.length <= 64
    && !slug.startsWith('.') && !slug.includes('/') && !slug.includes('\\') && slug !== '..'
    && /^[a-z0-9._-]+$/i.test(slug);
}

/**
 * 生成一份 SKILL.md 文本：frontmatter（name/description，安全转义引号）+ 正文。
 */
export function buildSkillMarkdown(slug: string, description: string, body: string): string {
  const escYaml = (s: string) => String(s).replace(/\n/g, ' ').replace(/"/g, '\\"').trim();
  return `---\nname: ${escYaml(slug)}\ndescription: "${escYaml(description)}"\n---\n\n${body}\n`;
}

/**
 * 组装 .skill 字节（STORE zip）。files 已含 <slug>/SKILL.md + 附加。
 * 纯函数：只依据输入返回 Buffer，不碰磁盘。
 */
export function assembleSkillBytes(input: AssembleSkillInput): { ok: true; bytes: Buffer } | { ok: false; reason: string } {
  if (!isSkillSlug(input.slug)) return { ok: false, reason: `slug「${String(input.slug)}」非法（须 1-64 位字母数字/._-，无 / 与 ..）` };
  const root = `${input.slug}/`;
  const files: SkillPackFile[] = [
    { zipPath: `${root}SKILL.md`, content: buildSkillMarkdown(input.slug, input.description || '', input.body || '') },
  ];
  if (input.extra) {
    for (const f of input.extra) {
      if (!f.zipPath.startsWith(root)) return { ok: false, reason: `附加文件必须位于 <slug>/ 下：${f.zipPath}` };
      if (f.zipPath === `${root}SKILL.md`) continue; // 防重复
      files.push({ zipPath: f.zipPath, content: f.content });
    }
  }
  return { ok: true, bytes: zipStore(files) };
}

/**
 * 生成 STORE(zip) 的 UTF-8 缓冲（files 已是完整 zip 条目列表，zipPath 去重）。
 * 结构：若干 local file header + 数据 → central directory → EOCD。
 * 时间戳用 DOS 格式（固定 2020-01-01 00:00，保证字节稳定可复现）。
 */
export function zipStore(files: SkillPackFile[]): Buffer {
  // 去重（zipPath 相同只留最后一条；防止调用方重复塞 SKILL.md）
  const seen = new Map<string, SkillPackFile>();
  for (const f of files) seen.set(f.zipPath, f);
  const uniq = [...seen.values()];

  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  const DOS_TIME = 0; // 0x21 时 0x21 分 0 秒
  const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1; // 2020-01-01

  let offset = 0;
  for (const f of uniq) {
    const nameBuf = Buffer.from(f.zipPath, 'utf8');
    const dataBuf = Buffer.from(f.content, 'utf8');
    const crc = crc32(dataBuf) >>> 0;

    // local file header（50 字节签名 + name）
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);      // PK\x03\x04
    lfh.writeUInt16LE(20, 4);              // version needed
    lfh.writeUInt16LE(0x0800, 6);          // flags: UTF-8
    lfh.writeUInt16LE(0, 8);               // method: STORE
    lfh.writeUInt16LE(DOS_TIME, 10);
    lfh.writeUInt16LE(DOS_DATE, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(dataBuf.length, 18); // compressed = size (store)
    lfh.writeUInt32LE(dataBuf.length, 22); // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26); // name length
    lfh.writeUInt16LE(0, 28);              // extra length
    chunks.push(lfh, nameBuf, dataBuf);

    // central directory header（46 字节签名 + name）
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);       // PK\x01\x02
    cd.writeUInt16LE(20, 4);               // version made by
    cd.writeUInt16LE(20, 6);               // version needed
    cd.writeUInt16LE(0x0800, 8);           // flags
    cd.writeUInt16LE(0, 10);               // method STORE
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(dataBuf.length, 20);
    cd.writeUInt32LE(dataBuf.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);  // name length
    cd.writeUInt16LE(0, 30);               // extra
    cd.writeUInt16LE(0, 32);               // comment
    cd.writeUInt16LE(0, 34);               // disk start
    cd.writeUInt16LE(0, 36);               // internal attrs
    cd.writeUInt32LE(0, 38);               // external attrs (dir? 0)
    cd.writeUInt32LE(offset, 42);          // local header offset
    central.push(cd, nameBuf);

    offset += lfh.length + nameBuf.length + dataBuf.length;
  }

  const cdStart = offset;
  const cdBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);       // PK\x05\x06
  eocd.writeUInt16LE(0, 4);                // disk
  eocd.writeUInt16LE(0, 6);                // cd start disk
  eocd.writeUInt16LE(uniq.length, 8);      // entries on disk
  eocd.writeUInt16LE(uniq.length, 10);     // total entries
  eocd.writeUInt32LE(cdBytes.length, 12);  // cd size
  eocd.writeUInt32LE(cdStart, 16);         // cd offset
  eocd.writeUInt16LE(0, 20);               // comment length

  return Buffer.concat([...chunks, cdBytes, eocd]);
}
