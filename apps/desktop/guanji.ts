/// <reference types="electron" />
import * as path from 'node:path';
import * as fs from 'node:fs';
import { app, safeStorage } from 'electron';

// ============================================================================
// 观雅集技能市场客户端（T-P6-1）
// ----------------------------------------------------------------------------
// 严格复用 guanji SKILL（v2.0.0）的 API 约定，不另起接口：
//   BASE_URL = https://skill.ytaiv.com
//   GET  /api/skills/recommend/latest          最近上新
//   GET  /api/skills/recommend/<featured|trending|top>  精品推送
//   GET  /api/skills/<slug>/download           下载 .skill 包
//   GET  /api/skills/<slug>/related            同类/关联推荐
//   GET  /api/auth/token                       登录 Cookie → 持久化 TOKEN
//   POST /api/upload/prepare                   x-upload-source: agent
//   POST /api/skills/upload                     multipart，publishMode=lingbi
//   POST /api/skills/<slug>/alias               body { alias }
//
// 红线（PLAN T-P6-1 防漂移）：
//   - TOKEN 由用户配置（userData/guanji.json），绝不硬编码。
//   - 安装前必须能力审查（capabilityReview），不得跳过；L3/L4 强制授权。
//   - 仅做下载/安装编排，不代替用户判断是否安装第三方 SKILL。
// ============================================================================

export const GUANJI_BASE_URL = 'https://skill.ytaiv.com';

export type SkillCapability =
  | 'prompt.read' | 'intent.classify' | 'flow.gate'
  | 'event.read' | 'pii.mask' | 'github.write'
  | 'agent.spawn' | 'agent.dispose' | 'memory.commit'
  | 'expert.load' | 'team.compose' | 'role.bind'
  | 'skill.fetch' | 'skill.install'
  | 'fs.read' | 'fs.write' | 'doc.review'
  | 'web.fetch' | 'cron.schedule'
  | 'browser.navigate' | 'browser.screenshot'
  | 'git.read' | 'git.write'
  | 'pdf.read' | 'pdf.write'
  | 'mail.send' | 'mail.read'
  | 'chart.render';

export interface GuanjiSkill {
  slug: string;
  name: string;
  description: string;
  caps: string[];
  /** 是否需要用户授权（L3+ 网络 / L4 Shell 或显式标注）。 */
  auth: 0 | 1;
  installed?: 0 | 1;
}

export interface TokenStatus {
  configured: boolean;
}

export interface InstallResult {
  ok: boolean;
  reason?: string;
  /** 能力审查结论：allowed（已授权/无需授权）/ needs-auth（需先授权）/ denied（被拒）。 */
  review: 'allowed' | 'needs-auth' | 'denied';
  path?: string;
}

export interface PublishInput {
  slug: string;
  alias?: string;
  /** 已打包的 .skill 文件路径（ZIP，根含 SKILL.md）。 */
  filePath: string;
}

export interface PublishResult {
  ok: boolean;
  reason?: string;
}

// L3（网络）/ L4（Shell/进程）能力 → 安装前必须授权。
const HIGH_RISK_CAPS = new Set<string>([
  'github.write', 'fs.write', 'doc.review', 'web.fetch', 'cron.schedule',
  'browser.navigate', 'browser.screenshot', 'git.write', 'pdf.write',
  'mail.send', 'mail.read',
]);

function configFile(): string {
  return path.join(app.getPath('userData'), 'guanji.json');
}

function readToken(): string | null {
  try {
    const file = configFile();
    if (fs.existsSync(file)) {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf-8')) as { enc?: string; token?: string };
      if (typeof cfg.enc === 'string' && cfg.enc) {
        // 加密格式（safeStorage）：无加密后端时无法解密，视为未配置（不降级明文）。
        if (!safeStorage.isEncryptionAvailable()) return null;
        return safeStorage.decryptString(Buffer.from(cfg.enc, 'base64'));
      }
      if (typeof cfg.token === 'string' && cfg.token) return cfg.token; // 旧明文格式兼容（首启迁移后不再写）
    }
  } catch {
    /* 配置损坏视为未配置 */
  }
  return null;
}

/** 写 TOKEN：一律经 safeStorage 加密（与 hub 凭据同策略）；无加密后端拒绝明文落盘。 */
function writeToken(token: string): { ok: boolean; reason?: string } {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, reason: '系统加密后端不可用（safeStorage），拒绝明文存储 TOKEN' };
  }
  try {
    const file = configFile();
    const enc = safeStorage.encryptString(token).toString('base64');
    fs.writeFileSync(file, JSON.stringify({ enc }), 'utf-8');
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `TOKEN 加密写入失败：${(err as Error).message}` };
  }
}

export class GuanjiClient {
  private baseUrl: string;

  constructor(baseUrl: string = GUANJI_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  /** 仅以 slug/name/desc/caps 构造最小技能对象（能力审查用）。 */
  private makeSkill(raw: { slug?: string; name?: string; description?: string; caps?: string[] }): GuanjiSkill {
    const caps = (raw.caps || []).filter((c): c is string => typeof c === 'string');
    const auth = caps.some((c) => HIGH_RISK_CAPS.has(c)) ? 1 : 0;
    return {
      slug: raw.slug || raw.name || 'unknown',
      name: raw.name || raw.slug || 'unknown',
      description: raw.description || '',
      caps,
      auth: auth as 0 | 1,
    };
  }

  /** TOKEN 配置状态（不返回 token 明文）。 */
  tokenStatus(): TokenStatus {
    return { configured: readToken() !== null };
  }

  /** 用户配置 TOKEN（来自登录后 GET /api/auth/token 的结果；不硬编码）。 */
  setToken(token: string): { ok: boolean; reason?: string } {
    if (!token || !token.trim()) return { ok: false, reason: 'TOKEN 为空' };
    return writeToken(token.trim());
  }

  /** 拉取观雅集真实技能列表（最近上新 + 精品推送合并去重）。 */
  async listSkills(): Promise<GuanjiSkill[]> {
    const token = readToken();
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const seen = new Map<string, GuanjiSkill>();
    const endpoints = [
      `${this.baseUrl}/api/skills/recommend/latest`,
      `${this.baseUrl}/api/skills/recommend/featured`,
      `${this.baseUrl}/api/skills/recommend/top`,
    ];
    for (const url of endpoints) {
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
        if (!res.ok) continue;
        const data = (await res.json()) as { items?: Array<Record<string, unknown>>; skills?: Array<Record<string, unknown>> };
        const items = (data.items || data.skills || []) as Array<{ slug?: string; name?: string; description?: string; caps?: string[] }>;
        for (const it of items) {
          const s = this.makeSkill(it);
          if (!seen.has(s.slug)) seen.set(s.slug, s);
        }
      } catch {
        // 单端点失败不影响其余；最终若全失败则由调用方回落静态样本。
      }
    }
    return [...seen.values()];
  }

  /**
   * 安装前能力审查（PLAN 红线：不得跳过）。
   * - 无高危能力（auth=0）→ allowed
   * - 高危能力（auth=1）：必须**用户显式授权**（authorized=true，渲染层确认弹窗）；
   *   配置了 TOKEN 不等于已授权——L3/L4 强制授权不可凭 token 绕过。
   */
  capabilityReview(skill: GuanjiSkill, authorized = false): 'allowed' | 'needs-auth' | 'denied' {
    if (skill.auth === 1 && !authorized) return 'needs-auth';
    return 'allowed';
  }

  /** 下载 .skill 包到本地 skills 目录（userData/skills/<slug>.skill）。 */
  async installSkill(skill: GuanjiSkill, authorized = false): Promise<InstallResult> {
    const review = this.capabilityReview(skill, authorized);
    if (review === 'needs-auth') {
      return { ok: false, review, reason: '该技能含 L3/L4 高危能力，需在确认弹窗中显式授权后安装' };
    }
    if (review === 'denied') {
      return { ok: false, review, reason: '能力审查未通过，拒绝安装' };
    }
    const token = readToken();
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    try {
      const res = await fetch(`${this.baseUrl}/api/skills/${encodeURIComponent(skill.slug)}/download`, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        return { ok: false, review, reason: `下载失败 HTTP ${res.status}` };
      }
      const dir = path.join(app.getPath('userData'), 'skills');
      fs.mkdirSync(dir, { recursive: true });
      const buf = Buffer.from(await res.arrayBuffer());
      const out = path.join(dir, `${skill.slug}.skill`);
      fs.writeFileSync(out, buf, 'utf-8');
      return { ok: true, review, path: out };
    } catch (err) {
      return { ok: false, review, reason: `下载异常：${(err as Error).message}` };
    }
  }

  /** 发布技能到观雅集（用户登录后；灵璧 Skill 走 publishMode=lingbi）。 */
  async publishSkill(input: PublishInput): Promise<PublishResult> {
    const token = readToken();
    if (!token) return { ok: false, reason: '请先登录观雅集并配置 TOKEN' };
    // 路径白名单：仅允许发布 userData/skills 目录内的 .skill 包（防任意文件外传）。
    const skillsDir = path.resolve(app.getPath('userData'), 'skills');
    const resolved = path.resolve(input.filePath);
    if (!resolved.startsWith(skillsDir + path.sep) || !resolved.endsWith('.skill')) {
      return { ok: false, reason: '发布文件必须位于 skills 目录内且为 .skill 包' };
    }
    if (!fs.existsSync(resolved)) return { ok: false, reason: '发布文件不存在' };
    try {
      // 1) 获取上传凭证
      const prep = await fetch(`${this.baseUrl}/api/upload/prepare`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'x-upload-source': 'agent' },
        body: JSON.stringify({ turnstile_token: 'agent' }),
        signal: AbortSignal.timeout(8000),
      });
      if (!prep.ok) return { ok: false, reason: `获取上传凭证失败 HTTP ${prep.status}` };
      const prepData = (await prep.json()) as { upload_token?: string };
      const uploadToken = prepData.upload_token;
      if (!uploadToken) return { ok: false, reason: '上传凭证缺失' };

      // 2) 上传并预发布（multipart/form-data）
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync(input.filePath)], { type: 'application/zip' }), `${input.slug}.skill`);
      form.append('publishMode', 'lingbi');
      const up = await fetch(`${this.baseUrl}/api/skills/upload`, {
        method: 'POST',
        headers: { 'X-Upload-Token': uploadToken },
        body: form,
        signal: AbortSignal.timeout(30000),
      });
      if (!up.ok) return { ok: false, reason: `上传失败 HTTP ${up.status}` };

      // 3) 设置雅称（可选）
      if (input.alias) {
        await fetch(`${this.baseUrl}/api/skills/${encodeURIComponent(input.slug)}/alias`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify({ alias: input.alias }),
          signal: AbortSignal.timeout(8000),
        });
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `发布异常：${(err as Error).message}` };
    }
  }
}

export const guanjiClient = new GuanjiClient();
