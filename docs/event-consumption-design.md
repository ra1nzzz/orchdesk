# Event Consumption Design — SSE(Ordexa) / WS(OrchClaw) 信封事件订阅原型

> 本文件按 ORCHDESK-UNIFICATION-PROMPT Phase 2 要求产出，为**设计文档（design doc）**，
> 不包含运行时实现。Phase 8 落地前须经母规范侧评审。

---

## 1. 背景与目标

OrchDesk 观台是生态的**桌面体验层**（Agent OS / 主交互界面）。当前 orchdesk 只**产生**事件
（`SessionEvent` NDJSON 日志），不消费任何外部事件总线。

Phase 8 目标：让 OrchDesk 成为生态中**最主要的跨产品事件消费端**，订阅：

- **Ordexa** 通过 SSE 推送的 Canonical Event Envelope（`/api/dsh/events`）
- **OrchClaw** 通过 WS 推送的 Canonical Event Envelope（`/ws/agent`）

消费后路由到 orchdesk 本地事件总线，驱动 UI 更新、记忆同步、审计日志等。

---

## 2. 架构概览

```text
┌─────────────┐     SSE      ┌─────────────┐     WS      ┌─────────────┐
│   Ordexa    │─────────────▶│  OrchDesk   │────────────▶│  OrchClaw   │
│  (事件源 A)  │  envelope    │  SSE Consumer│  envelope   │  (事件源 B)  │
└─────────────┘              └──────┬──────┘             └─────────────┘
                                    │
                                    ▼
                          ┌─────────────────┐
                          │  Canonical Event │
                          │     Router       │
                          └────────┬────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
       ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
       │  Session UI  │     │  Memory Sync │     │  Audit Log   │
       │  (实时更新)   │     │  (记忆同步)   │     │  (审计落盘)   │
       └─────────────┘     └─────────────┘     └─────────────┘
```

---

## 3. Canonical Event Envelope 格式

> 依据 `DECISION-LOG.md` D-005 裁决。

```typescript
interface CanonicalEventEnvelope {
  id: string;              // UUID v4
  type: string;            // domain.action 小写点分，如 `task.created`
  actor: {
    type: 'user' | 'agent' | 'system';
    id: string;            // 触发者标识
  };
  subject: {
    type: string;          // 主体类型，如 `Session` / `Task` / `Agent`
    id: string;            // 主体实例 id
  };
  timestamp: string;       // ISO-8601
  context: Record<string, unknown>;  // 附加上下文（sessionId、taskId 等）
  payload: Record<string, unknown>;  // 事件载荷（结构化数据）
}
```

---

## 4. SSE 消费者设计（Ordexa）

### 4.1 连接端点

```
GET https://<ordexa-host>/api/dsh/events
Headers:
  Authorization: Bearer <token>
  Accept: text/event-stream
```

### 4.2 原型实现

```typescript
// apps/desktop/event-consumer/ordeax-sse.ts (设计稿，Phase 8 实现)

interface SSEConsumerOptions {
  url: string;
  token: string;
  onEvent: (envelope: CanonicalEventEnvelope) => void;
  onError: (err: Error) => void;
  reconnectDelayMs?: number;
}

class SSEConsumer {
  private es: EventSource | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private opts: SSEConsumerOptions) {}

  start(): void {
    this.es = new EventSource(this.opts.url, {
      // 注意：EventSource 不支持自定义 headers；token 需通过 URL query 或
      // 服务端 cookie/session 传递。若必须 Bearer header，改用 fetch + ReadableStream。
    });
    this.es.onmessage = (ev) => this.handleMessage(ev.data);
    this.es.onerror = () => this.opts.onError(new Error('SSE connection error'));
  }

  private handleMessage(raw: string): void {
    try {
      const envelope = JSON.parse(raw) as CanonicalEventEnvelope;
      this.opts.onEvent(envelope);
    } catch (e) {
      this.opts.onError(new Error(`Failed to parse SSE event: ${e}`));
    }
  }

  stop(): void {
    this.es?.close();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
  }
}
```

### 4.3 Bearer Token 问题

EventSource API **不支持自定义 headers**。两种解决方案：

| 方案 | 说明 | 推荐 |
|---|---|---|
| A. URL query param | `?token=<jwt>`；需 HTTPS + 短过期 token | 快速原型 |
| B. fetch + ReadableStream | 手动解析 SSE；可带 headers；更灵活 | 生产 |

**原型推荐方案 B**：

```typescript
async function* sseStream(url: string, headers: HeadersInit): AsyncGenerator<CanonicalEventEnvelope> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`SSE HTTP ${res.status}`);
  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('data:')) {
        const raw = line.slice(5).trim();
        if (raw) yield JSON.parse(raw) as CanonicalEventEnvelope;
      }
    }
  }
}
```

---

## 5. WS 消费者设计（OrchClaw）

### 5.1 连接端点

```
WS ws://<orchclaw-host>/ws/agent
Headers:
  Authorization: Bearer <token>
```

OrchClaw WS 协议已支持 Canonical  envelope（Phase 3/5 双写），消息格式：

```json
{
  "type": "envelope",
  "envelope": { /* CanonicalEventEnvelope */ }
}
```

### 5.2 原型实现

```typescript
// apps/desktop/event-consumer/orchclaw-ws.ts (设计稿，Phase 8 实现)

interface WSConsumerOptions {
  url: string;
  token: string;
  onEvent: (envelope: CanonicalEventEnvelope) => void;
  onError: (err: Error) => void;
}

class WSConsumer {
  private ws: WebSocket | null = null;
  private reconnectMs = 1000;

  constructor(private opts: WSConsumerOptions) {}

  start(): void {
    const url = new URL(this.opts.url);
    url.searchParams.set('token', this.opts.token);
    this.ws = new WebSocket(url.toString());
    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'envelope') {
          this.opts.onEvent(msg.envelope as CanonicalEventEnvelope);
        }
      } catch (e) {
        this.opts.onError(new Error(`WS parse error: ${e}`));
      }
    };
    this.ws.onclose = () => this.scheduleReconnect();
    this.ws.onerror = () => this.opts.onError(new Error('WS error'));
  }

  private scheduleReconnect(): void {
    setTimeout(() => this.start(), this.reconnectMs);
  }

  stop(): void {
    this.ws?.close();
  }
}
```

---

## 6. 本地事件总线桥接

### 6.1 路由表

| Canonical Event Type | OrchDesk 本地动作 | 触发位置 |
|---|---|---|
| `task.created` | UI 新增任务卡片 | 渲染层 |
| `task.updated` | UI 刷新任务状态 | 渲染层 |
| `task.completed` | 记忆晋升候选 | memory plugin |
| `session.user_message` | 会话列表高亮 | session-events |
| `session.assistant_turn` | 时间线更新 | session-events |
| `session.forked` | 血缘树展开 | session-events |
| `approval.created` | 授权弹窗 | authz plugin |
| `agent.spawned` / `agent.disposed` | SubAgent 芯片 | brain plugin |

### 6.2 实现位置

```typescript
// apps/desktop/event-consumer/router.ts (设计稿)

type EventHandler = (envelope: CanonicalEventEnvelope) => void;

const handlers = new Map<string, EventHandler[]>([
  ['task.created', [uiTaskCreated, memorySync]],
  ['task.completed', [memoryPromote]],
  ['session.user_message', [uiHighlightSession]],
  // ...
]);

export function routeEvent(envelope: CanonicalEventEnvelope): void {
  const list = handlers.get(envelope.type) || [];
  for (const fn of list) {
    try { fn(envelope); } catch (e) { console.error('[orchdesk] event handler error:', e); }
  }
}
```

---

## 7. 错误处理与重连策略

| 场景 | 策略 |
|---|---|
| SSE/WS 断开 | 指数退避重连（1s → 2s → 4s → 最大 30s） |
| 单条事件解析失败 | 跳过，记录 warn，不中断流 |
| 事件处理器抛错 | catch 隔离，不影响其他 handler |
| 认证失效 (401/403) | 停止重连，上报 UI，要求用户重新授权 |
| 网络不可达 | 降级为本地事件模式（只写不发），恢复后补同步 |

---

## 8. 原型实现边界

### 8.1 已实现（Phase 8 核心）

- [x] `apps/desktop/event-emit.ts` — Canonical Event 双写模块
- [x] `apps/desktop/event-consumer/router.ts` — 事件路由（10 种 canonical 类型预注册）
- [x] `apps/desktop/event-consumer/sse-consumer.ts` — Ordexa SSE 消费者（fetch + ReadableStream）
- [x] `apps/desktop/event-consumer/ws-consumer.ts` — OrchClaw WS 消费者（原生 WebSocket）
- [x] `apps/desktop/main.ts` — runAgentTurn / executeTool 接入事件双写
- [ ] `apps/desktop/event-emit-verify.cjs` — 单元测试（需编译后运行）

### 8.2 明确不实现

- ❌ 实际 SSE/WS 网络连接代码（消费者类已就绪，连接由外部配置驱动）
- ❌ 事件持久化（OrchDesk 本地仍只写 SessionEvent NDJSON）
- ❌ 事件回溯/重放（Phase 8 之后考虑）
- ❌ 跨产品事件溯源（需要 Canonical Event Store，超出 Phase 8 范围）

### 8.3 Phase 8 后续清单

1. 编译并运行 `apps/desktop/event-emit-verify.cjs` 验证双写逻辑
2. 与 Ordexa / OrchClaw 联调（需两端同时开启双写）
3. Router 内置 handler 落地（UI 更新 / 记忆同步 / 审计落盘）
4. 配置化：SSE/WS endpoint / token 持久化到 dataDir

---

## 9. 与现有代码的关系

| 现有模块 | 关系 | 说明 |
|---|---|---|
| `session-events.ts` | 只读消费者 | 外部事件不写入 SessionEvent NDJSON；本地事件流仍是权威源 |
| `dsh-runtime.ts` | 独立于运行时 | 事件消费者在主进程独立运行，不经过 Cordis plugin 机制 |
| `hub.ts` | 不同协议 | HubClient 是 REST 客户端；本设计是事件流消费者，不替代 |
| `brain plugin` | 事件生产者+消费者 | SubAgent dispatch/dispose 本地 emit 事件；Phase 8 可桥接 Canonical envelope |

---

## 10. 开放问题

1. Ordexa SSE endpoint 是否需要 OAuth2 / JWT 刷新机制？（当前假设静态 token）
2. OrchClaw WS 是否支持 per-session 过滤（只收特定 Session 的事件）？
3. 事件积压（backpressure）如何处理？—— 本地丢弃旧事件 / 限速 / 缓冲队列？
4. 首次同步（histroy replay）是否需要？—— 当前设计只收实时事件。
