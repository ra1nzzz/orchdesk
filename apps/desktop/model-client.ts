/**
 * 模型 HTTP 客户端（OpenAI 兼容 + Ollama）。
 * 不依赖 electron：解密钥匙由宿主注入。可传入 AbortSignal 中止进行中的 fetch。
 */
import { normalizeNativeToolCalls, type ApiMessage, type ModelReply, type NativeToolCall, TOOL_DEFS } from './agent-runtime';
import { normalizeApiUsage } from './usage-registry';
import { logModel } from './logger';

export type ModelProviderLike = {
  name: string;
  type: string;
  baseUrl: string;
  apiKeyEnc?: string;
  apiMode?: 'chat' | 'responses' | 'completions';
};

export type CallModelOpts = {
  signal?: AbortSignal;
  /** 增量文本（SSE/NDJSON 按 chunk；JSON 整包一次）。失败不影响回合。 */
  onDelta?: (chunk: string) => void;
};

type DecryptKey = (encB64?: string) => string;

let decryptKeyFn: DecryptKey = () => '';

export function initModelClient(deps: { decryptKey: DecryptKey }): void {
  decryptKeyFn = deps.decryptKey;
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string };
  return e.name === 'AbortError' || /aborted|AbortError/i.test(String(e.message || ''));
}

/** 用户中止 ∪ 120s 超时。Node 22+ 走 AbortSignal.any。 */
export function requestSignal(user?: AbortSignal, ms = 120_000): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!user) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([user, timeout]);
  const ac = new AbortController();
  const onAbort = (): void => ac.abort();
  if (user.aborted || timeout.aborted) {
    ac.abort();
    return ac.signal;
  }
  user.addEventListener('abort', onAbort, { once: true });
  timeout.addEventListener('abort', onAbort, { once: true });
  return ac.signal;
}

function emitDelta(opts: CallModelOpts, chunk: string): void {
  if (!chunk || typeof opts.onDelta !== 'function') return;
  try { opts.onDelta(chunk); } catch { /* 渲染层失败不影响回合 */ }
}

export function looksLikeSse(raw: string): boolean {
  const t = raw.trimStart();
  return t.startsWith('data:') || t.startsWith('event:');
}

const STREAM_DROP_STATUSES = [400, 415, 422];

/** stream:true 被拒时同轮改 stream:false。含 tool 的 400 仍走工具降级，不抢先卸流。 */
export function shouldRetryWithoutStream(status: number, bodyText: string, streaming: boolean): boolean {
  if (!streaming) return false;
  if (!STREAM_DROP_STATUSES.includes(status)) return false;
  if (/stream/i.test(bodyText)) return true;
  if (/tool|function/i.test(bodyText)) return false;
  return true;
}

type SseToolAcc = { id?: string; type?: string; function?: { name?: string; arguments?: string } };

/** 行缓冲 OpenAI SSE。可多次 push，end() 冲掉最后半行。 */
export class OpenAiSseParser {
  content = '';
  finish?: unknown;
  usage?: unknown;
  private buf = '';
  private toolsByIndex = new Map<number, SseToolAcc>();
  constructor(private onDelta?: (chunk: string) => void) {}
  push(text: string): void {
    this.buf += text;
    const lines = this.buf.split(/\r?\n/);
    this.buf = lines.pop() || '';
    for (const line of lines) this.consumeLine(line);
  }
  end(): { content: string; toolCalls: unknown; finish?: unknown; usage?: unknown } {
    if (this.buf.trim()) this.consumeLine(this.buf);
    this.buf = '';
    return { content: this.content, toolCalls: [...this.toolsByIndex.values()], finish: this.finish, usage: this.usage };
  }
  private consumeLine(line: string): void {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let json: Record<string, unknown>;
    try { json = JSON.parse(payload) as Record<string, unknown>; } catch { return; }
    if (json.usage) this.usage = json.usage;
    const choice = (json.choices as Array<{
      delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
      finish_reason?: unknown;
    }> | undefined)?.[0];
    if (!choice) return;
    if (choice.finish_reason != null) this.finish = choice.finish_reason;
    const delta = choice.delta;
    if (delta?.content) {
      this.content += delta.content;
      this.onDelta?.(delta.content);
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const acc = this.toolsByIndex.get(idx) || { type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.function!.name = (acc.function!.name || '') + tc.function.name;
        if (tc.function?.arguments) acc.function!.arguments = (acc.function!.arguments || '') + tc.function.arguments;
        this.toolsByIndex.set(idx, acc);
      }
    }
  }
}

export function consumeOpenAiSse(
  raw: string,
  onDelta?: (chunk: string) => void,
): { content: string; toolCalls: unknown; finish?: unknown; usage?: unknown } {
  const p = new OpenAiSseParser(onDelta);
  p.push(raw);
  return p.end();
}

export class OllamaNdjsonParser {
  content = '';
  toolCalls: unknown = [];
  done_reason?: unknown;
  private buf = '';
  constructor(private onDelta?: (chunk: string) => void) {}
  push(text: string): void {
    this.buf += text;
    const lines = this.buf.split(/\r?\n/);
    this.buf = lines.pop() || '';
    for (const line of lines) this.consumeLine(line);
  }
  end(): { content: string; toolCalls: unknown; done_reason?: unknown } {
    if (this.buf.trim()) this.consumeLine(this.buf);
    this.buf = '';
    return { content: this.content, toolCalls: this.toolCalls, done_reason: this.done_reason };
  }
  private consumeLine(line: string): void {
    const t = line.trim();
    if (!t) return;
    let obj: { message?: { content?: string; tool_calls?: unknown }; done_reason?: unknown };
    try { obj = JSON.parse(t) as typeof obj; } catch { return; }
    const piece = obj.message?.content || '';
    if (piece) {
      this.content += piece;
      this.onDelta?.(piece);
    }
    if (obj.message?.tool_calls) this.toolCalls = obj.message.tool_calls;
    if (obj.done_reason != null) this.done_reason = obj.done_reason;
  }
}

export function consumeOllamaNdjson(
  raw: string,
  onDelta?: (chunk: string) => void,
): { content: string; toolCalls: unknown; done_reason?: unknown } {
  const p = new OllamaNdjsonParser(onDelta);
  p.push(raw);
  return p.end();
}

/** 有 ReadableStream 则逐块读（真流式）；否则 res.text()。 */
export async function readStreamingText(
  res: Response,
  onPiece?: (piece: string) => void,
): Promise<string> {
  const body = res.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== 'function') {
    return res.text();
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const piece = decoder.decode(value, { stream: true });
      if (piece) {
        raw += piece;
        onPiece?.(piece);
      }
    }
    const tail = decoder.decode();
    if (tail) {
      raw += tail;
      onPiece?.(tail);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return raw;
}

type BodyDetectKind = 'unknown' | 'sse' | 'ndjson';

function createBodyDetector(onDelta?: (chunk: string) => void) {
  let kind: BodyDetectKind = 'unknown';
  let buf = '';
  let sse: OpenAiSseParser | undefined;
  let nd: OllamaNdjsonParser | undefined;
  return {
    push(piece: string): void {
      if (kind === 'sse') { sse!.push(piece); return; }
      if (kind === 'ndjson') { nd!.push(piece); return; }
      buf += piece;
      const t = buf.trimStart();
      if (t.startsWith('data:') || t.startsWith('event:')) {
        kind = 'sse';
        sse = new OpenAiSseParser(onDelta);
        sse.push(buf);
        buf = '';
        return;
      }
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const first = buf.slice(0, nl).trim();
      if (!first.startsWith('{')) return;
      try {
        const obj = JSON.parse(first) as { message?: unknown; done?: unknown };
        if (obj && (obj.message !== undefined || obj.done !== undefined)) {
          kind = 'ndjson';
          nd = new OllamaNdjsonParser(onDelta);
          nd.push(buf);
          buf = '';
        }
      } catch { /* 首行还不是完整 JSON */ }
    },
    kind(): BodyDetectKind { return kind; },
    endSse() { return sse ? sse.end() : null; },
    endNdjson() { return nd ? nd.end() : null; },
  };
}

export async function callModel(
  provider: ModelProviderLike,
  model: string,
  messages: ApiMessage[],
  toolDefs: typeof TOOL_DEFS = [],
  opts: CallModelOpts = {},
): Promise<ModelReply> {
  if (provider.type === 'ollama') {
    return callOllama(provider, model, messages, toolDefs, opts);
  }
  return callOpenAICompatible(provider, model, messages, toolDefs, opts);
}

export async function callOllama(
  provider: ModelProviderLike,
  model: string,
  messages: ApiMessage[],
  toolDefs: typeof TOOL_DEFS = [],
  opts: CallModelOpts = {},
): Promise<ModelReply> {
  const url = provider.baseUrl.replace(/\/$/, '') + '/api/chat';
  const t0 = Date.now();
  const post = async (stream: boolean): Promise<Response> => {
    const body: Record<string, unknown> = { model, messages, stream };
    if (toolDefs.length) body.tools = toolDefs;
    logModel('request', { provider: provider.name, model, apiMode: 'ollama', url, toolCalls: toolDefs.length });
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: requestSignal(opts.signal),
    }).catch((err) => {
      logModel('error', { provider: provider.name, model, apiMode: 'ollama', url, ms: Date.now() - t0, error: (err as Error).message });
      throw err;
    });
  };
  let res = await post(true);
  if (!res.ok) {
    const txt = await res.text();
    if (shouldRetryWithoutStream(res.status, txt, true)) {
      logModel('error', { provider: provider.name, model, apiMode: 'ollama', url, status: res.status, error: `stream 降级：${txt.slice(0, 120)}` });
      res = await post(false);
    } else {
      throw new Error(`Ollama 返回 HTTP ${res.status}: ${txt.slice(0, 300)}`);
    }
  }
  if (!res.ok) throw new Error(`Ollama 返回 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const detector = createBodyDetector(opts.onDelta);
  const rawBody = await readStreamingText(res, (piece) => detector.push(piece));
  let data: {
    message?: { content?: string; tool_calls?: unknown };
    error?: string;
    done_reason?: string;
  };
  const nd = detector.kind() === 'ndjson' ? detector.endNdjson() : null;
  if (nd && (nd.content || (Array.isArray(nd.toolCalls) && nd.toolCalls.length))) {
    const toolCalls = normalizeNativeToolCalls(nd.toolCalls);
    logModel('response', {
      provider: provider.name, model, apiMode: 'ollama', url,
      status: res.status, ms: Date.now() - t0,
      contentLen: nd.content.length, toolCalls: toolCalls.length,
    });
    return {
      content: nd.content,
      toolCalls,
      source: toolCalls.length ? 'native' : 'none',
      emptyReason: (!nd.content && !toolCalls.length)
        ? emptyContentReason({
            provider: provider.name, model, mode: 'ollama', status: res.status,
            finish: nd.done_reason, bodySnippet: rawBody.slice(0, 200),
          })
        : undefined,
    };
  }
  try {
    data = JSON.parse(rawBody) as typeof data;
  } catch {
    const streamed = consumeOllamaNdjson(rawBody, opts.onDelta);
    if (streamed.content || (Array.isArray(streamed.toolCalls) && streamed.toolCalls.length)) {
      const toolCalls = normalizeNativeToolCalls(streamed.toolCalls);
      logModel('response', {
        provider: provider.name, model, apiMode: 'ollama', url,
        status: res.status, ms: Date.now() - t0,
        contentLen: streamed.content.length, toolCalls: toolCalls.length,
      });
      return {
        content: streamed.content,
        toolCalls,
        source: toolCalls.length ? 'native' : 'none',
        emptyReason: (!streamed.content && !toolCalls.length)
          ? emptyContentReason({
              provider: provider.name, model, mode: 'ollama', status: res.status,
              finish: streamed.done_reason, bodySnippet: rawBody.slice(0, 200),
            })
          : undefined,
      };
    }
    throw new Error(`Ollama 返回非 JSON 响应（HTTP ${res.status}）: ${rawBody.slice(0, 200)}`);
  }
  if (data.error) throw new Error(data.error);

  const toolCalls = normalizeNativeToolCalls(data.message?.tool_calls);
  const content = data.message?.content || '';
  emitDelta(opts, content);
  logModel('response', {
    provider: provider.name, model, apiMode: 'ollama', url,
    status: res.status, ms: Date.now() - t0,
    contentLen: content.length, toolCalls: toolCalls.length,
  });
  return {
    content,
    toolCalls,
    source: toolCalls.length ? 'native' : 'none',
    usage: normalizeApiUsage(data) || undefined,
    emptyReason: (!content && !toolCalls.length)
      ? emptyContentReason({
          provider: provider.name,
          model,
          mode: 'ollama',
          status: res.status,
          finish: data.done_reason,
          bodySnippet: rawBody.slice(0, 200),
        })
      : undefined,
  };
}

export function buildRequest(base: string, mode: 'chat' | 'responses' | 'completions', model: string, messages: ApiMessage[], stream = false): { url: string; body: Record<string, unknown> } {
  const isFullEndpoint = /\/chat\/completions|\/responses|\/completions/.test(base);
  const clean = base.replace(/\/v1\/?$/, '');

  if (mode === 'responses') {
    const input = messages.map(m => ({
      role: m.role === 'system' ? 'developer' as const : m.role,
      content: m.content || '',
    }));
    return {
      url: isFullEndpoint ? base : clean + '/v1/responses',
      body: { model, input },
    };
  }
  if (mode === 'completions') {
    return {
      url: isFullEndpoint ? base : clean + '/v1/completions',
      body: { model, prompt: messages.map(m => `${m.role}: ${m.content || ''}`).join('\n'), max_tokens: 1024 },
    };
  }
  return {
    url: isFullEndpoint ? base : clean + '/v1/chat/completions',
    body: { model, messages, stream },
  };
}

export function pickOpenAIContent(data: Record<string, unknown>, mode: 'chat' | 'responses' | 'completions'): string {
  if (mode === 'responses') {
    const direct = (data as { output_text?: string }).output_text;
    if (typeof direct === 'string' && direct) return direct;
    const out = (data as { output?: Array<{ type?: string; content?: Array<{ text?: string }> }> }).output;
    if (Array.isArray(out)) {
      const parts: string[] = [];
      for (const item of out) {
        if (item?.type === 'message' && Array.isArray(item.content)) {
          for (const c of item.content) if (typeof c?.text === 'string') parts.push(c.text);
        }
      }
      if (parts.length) return parts.join('\n');
    }
    return '';
  }
  if (mode === 'completions') {
    return ((data as { choices?: Array<{ text?: string }> }).choices?.[0]?.text || '');
  }
  const raw = (data as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw.map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
      ? (c as { text: string }).text
      : '')).join('');
  }
  return '';
}

export function emptyContentReason(opts: { provider: string; model: string; mode: string; status: number; finish?: unknown; bodySnippet: string }): string {
  const parts = [
    '模型返回空内容',
    `provider=${opts.provider}`,
    `model=${opts.model}`,
    `apiMode=${opts.mode}`,
    `HTTP ${opts.status}`,
  ];
  if (opts.finish !== undefined) parts.push(`finish_reason=${String(opts.finish)}`);
  if (opts.bodySnippet) parts.push(`响应片段: ${opts.bodySnippet}`);
  return `（${parts.join(' · ')}）`;
}

export async function callOpenAICompatible(
  provider: ModelProviderLike,
  model: string,
  messages: ApiMessage[],
  toolDefs: typeof TOOL_DEFS = [],
  opts: CallModelOpts = {},
): Promise<ModelReply> {
  const apiKey = decryptKeyFn(provider.apiKeyEnc);
  if (!apiKey) throw new Error(`提供商「${provider.name}」未配置 API Key，请先在设置页配置`);
  const mode = provider.apiMode || 'chat';
  const base = provider.baseUrl.replace(/\/+$/, '');

  const canUseTools = mode === 'chat' && toolDefs.length > 0;
  const attempts: Array<{ tools: boolean; toolChoice: boolean }> = canUseTools
    ? [{ tools: true, toolChoice: true }, { tools: true, toolChoice: false }, { tools: false, toolChoice: false }]
    : [{ tools: false, toolChoice: false }];

  let lastErr = '';
  let preferStream = mode === 'chat';
  attLoop: for (const att of attempts) {
    const streamTries = preferStream ? [true, false] : [false];
    for (const useStream of streamTries) {
    const { url, body } = buildRequest(base, mode, model, messages, useStream);
    if (att.tools) {
      body.tools = toolDefs;
      if (att.toolChoice) body.tool_choice = 'auto';
    }
    const t0 = Date.now();
    logModel('request', {
      provider: provider.name, model, apiMode: mode, url,
      toolCalls: att.tools ? toolDefs.length : 0,
      ...(att.tools ? {} : { error: canUseTools ? `tools 降级（att.tools=${att.tools}）` : undefined }),
    });

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: requestSignal(opts.signal),
      });
    } catch (err) {
      logModel('error', { provider: provider.name, model, apiMode: mode, url, ms: Date.now() - t0, error: (err as Error).message });
      throw new Error(`请求模型接口失败：${(err as Error).message}`);
    }

    if (!res.ok) {
      const txt = await res.text();
      lastErr = `模型 API 返回 HTTP ${res.status}: ${txt.slice(0, 300)}`;
      logModel('error', { provider: provider.name, model, apiMode: mode, url, status: res.status, ms: Date.now() - t0, error: txt.slice(0, 200) });
      if (shouldRetryWithoutStream(res.status, txt, useStream)) {
        preferStream = false;
        continue;
      }
      if (att.tools && [400, 404, 415, 422].includes(res.status)) continue attLoop;
      throw new Error(lastErr);
    }

    const detector = createBodyDetector(opts.onDelta);
    const rawBody = await readStreamingText(res, (piece) => detector.push(piece));
    let data: Record<string, unknown>;
    const sseHit = detector.kind() === 'sse' ? detector.endSse() : (looksLikeSse(rawBody) ? consumeOpenAiSse(rawBody, opts.onDelta) : null);
    if (sseHit) {
      const streamed = sseHit;
      const toolCalls = normalizeNativeToolCalls(streamed.toolCalls);
      if (!streamed.content && !toolCalls.length && att.tools) {
        lastErr = emptyContentReason({ provider: provider.name, model, mode, status: res.status, finish: streamed.finish, bodySnippet: rawBody.slice(0, 200) });
        continue attLoop;
      }
      logModel('response', {
        provider: provider.name, model, apiMode: mode, url,
        status: res.status, ms: Date.now() - t0,
        contentLen: streamed.content.length, toolCalls: toolCalls.length,
      });
      return {
        content: streamed.content,
        toolCalls,
        source: toolCalls.length ? 'native' : 'none',
        usage: normalizeApiUsage({ usage: streamed.usage }) || undefined,
        emptyReason: (!streamed.content && !toolCalls.length)
          ? emptyContentReason({ provider: provider.name, model, mode, status: res.status, finish: streamed.finish, bodySnippet: rawBody.slice(0, 200) })
          : undefined,
      };
    }
    try {
      data = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      if (looksLikeSse(rawBody)) {
        const streamed = consumeOpenAiSse(rawBody, opts.onDelta);
        const toolCalls = normalizeNativeToolCalls(streamed.toolCalls);
        if (!streamed.content && !toolCalls.length && att.tools) {
          lastErr = emptyContentReason({ provider: provider.name, model, mode, status: res.status, finish: streamed.finish, bodySnippet: rawBody.slice(0, 200) });
          continue attLoop;
        }
        logModel('response', {
          provider: provider.name, model, apiMode: mode, url,
          status: res.status, ms: Date.now() - t0,
          contentLen: streamed.content.length, toolCalls: toolCalls.length,
        });
        return {
          content: streamed.content,
          toolCalls,
          source: toolCalls.length ? 'native' : 'none',
          usage: normalizeApiUsage({ usage: streamed.usage }) || undefined,
          emptyReason: (!streamed.content && !toolCalls.length)
            ? emptyContentReason({ provider: provider.name, model, mode, status: res.status, finish: streamed.finish, bodySnippet: rawBody.slice(0, 200) })
            : undefined,
        };
      }
      throw new Error(`模型 API 返回非 JSON 响应（HTTP ${res.status} · apiMode=${mode}）: ${rawBody.slice(0, 200)}`);
    }
    const errMsg = (data as { error?: { message?: string } }).error?.message;
    if (errMsg) {
      lastErr = errMsg;
      if (useStream && /stream/i.test(errMsg)) {
        preferStream = false;
        continue;
      }
      if (att.tools && /tool|function/i.test(errMsg)) continue attLoop;
      throw new Error(errMsg);
    }

    const choice = (data as { choices?: Array<{ message?: { content?: string; tool_calls?: unknown }; finish_reason?: unknown }> }).choices?.[0];
    const toolCalls = normalizeNativeToolCalls(choice?.message?.tool_calls);
    const content = pickOpenAIContent(data, mode) || (typeof choice?.message?.content === 'string' ? choice.message.content : '');
    const finish = choice?.finish_reason;

    if (!content && !toolCalls.length && att.tools) {
      lastErr = emptyContentReason({ provider: provider.name, model, mode, status: res.status, finish, bodySnippet: rawBody.slice(0, 200) });
      logModel('error', { provider: provider.name, model, apiMode: mode, url, status: res.status, ms: Date.now() - t0, error: `[softReject] ${lastErr}` });
      continue attLoop;
    }

    emitDelta(opts, content);
    logModel('response', {
      provider: provider.name, model, apiMode: mode, url,
      status: res.status, ms: Date.now() - t0,
      contentLen: content.length, toolCalls: toolCalls.length,
    });
    return {
      content,
      toolCalls,
      source: toolCalls.length ? 'native' : 'none',
      usage: normalizeApiUsage(data) || undefined,
      toolsRejected: canUseTools && !att.tools && content ? true : undefined,
      emptyReason: (!content && !toolCalls.length)
        ? emptyContentReason({ provider: provider.name, model, mode, status: res.status, finish, bodySnippet: rawBody.slice(0, 200) })
        : undefined,
    };
    }
  }
  throw new Error(lastErr || '模型调用失败（未知原因）');
}

export type { NativeToolCall };
