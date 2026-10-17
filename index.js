// dsh-model-failover — 模型故障自动转移（供应商池内轮询）
//
// 【职责】模型请求失败（限流/配额/超时/服务端错误等）时，自动把该次请求切到
// 「所选供应商池」中的下一个模型重试。池 = 用户选定的一个或多个供应商下的
// 全部模型（来自官方 modelCatalog，按供应商顺序 + 目录顺序展开）。
//
// 【机制】（均经 asar 源码核对）
//   · 官方重试插件 dsh-llm-retry 监听 `agent/request-error` 瀑布流：同供应商
//     重试次数用尽（或失败码不在其策略内）时返回 undefined，控制权落到下游
//     监听器 —— 本插件在下游接住，返回 { kind: "retry" } 让 agent-loop 重跑
//     prepareRequest → 重新走 `agent/request` 瀑布。
//   · `agent/request` 瀑布流里对 resolved 配置改写 provider/model（与
//     dsh-session-conductor 成员模型切换同款、已验证可行的模式）。重试时
//     pending 目标生效；非 sticky 模式下新回合自动回到默认模型。
//   · 失败分类只认 failure.code（机器可路由），绝不解析报错文本。
//
// 【为什么不写会话事件】Session 拒绝未知 type 的非 ignorable 事件；故障转移
// 状态存内存 Map + <DSH_HOME>/model-failover/state.json（含 lastCatalog 快照，
// 重启后 modelCatalog 不可用时兜底）。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const name = "dsh-model-failover";

// ---------------------------------------------------------------------------
// Config（声明式 schema；工作区自测环境无宿主依赖时降级为不校验）
// ---------------------------------------------------------------------------
const DEFAULT_RETRYABLE_CODES = Object.freeze([
  "RATE_LIMIT",      // 限流
  "QUOTA",           // 配额/余额耗尽
  "ACCOUNT_QUOTA",   // 账号级配额耗尽
  "SERVER",          // 5xx 服务端错误
  "TIMEOUT",         // 超时
  "TRANSPORT",       // 网络传输失败
  "EMPTY_RESPONSE",  // 空响应（重试安全）
  "NO_ADAPTER",      // 该 provider 未注册适配器（切到其它供应商有意义）
]);

export let Config;
try {
  const { default: Schema } = await import("@deepseek-ai/schemastery");
  Config = Schema.object({
    enabled: Schema.boolean().default(true).description("总开关"),
    providers: Schema.array(Schema.string()).default([]).description("默认供应商池（按顺序）；空 = 运行时用 model_failover 工具设置"),
    retryableCodes: Schema.array(Schema.string()).default([...DEFAULT_RETRYABLE_CODES]).description("触发转移的失败码（Harness 机器可路由 code）"),
    sticky: Schema.boolean().default(false).description("转移后粘在该会话（直到该模型再失败推进或 clear）"),
    maxFailoverAttempts: Schema.number().default(0).description("单次故障最多转移几个候选（0 = 整个池子）"),
  }).description("模型故障自动转移");
} catch {
  Config = undefined; // 无宿主依赖（工作区自测）→ 不声明 schema，config 原样传入
}

// ---------------------------------------------------------------------------
// 状态文件：<DSH_HOME>/model-failover/state.json
//   providers        运行时供应商池（model_failover set 写入，优先于 config）
//   disabled         运行时总闸（model_failover disable）
//   stickyOverrides  sessionId → {provider, model}（sticky 模式的持久粘滞）
//   lastCatalog      {providerId → modelId[]}（modelCatalog 快照，重启兜底）
//   events           最近 20 条转移事件（status 查看）
// ---------------------------------------------------------------------------
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}
function stateFile() {
  return path.join(dshHome(), "model-failover", "state.json");
}
function defaultState() {
  return { providers: [], disabled: false, stickyOverrides: {}, lastCatalog: {}, events: [] };
}
function readStateRaw() {
  try {
    const raw = fs.readFileSync(stateFile(), "utf8");
    const parsed = JSON.parse(raw);
    return { ...defaultState(), ...(parsed && typeof parsed === "object" ? parsed : {}) };
  } catch {
    return defaultState();
  }
}
function writeState(state) {
  try {
    const dir = path.dirname(stateFile());
    fs.mkdirSync(dir, { recursive: true });
    const tmp = stateFile() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, stateFile());
    return true;
  } catch {
    return false;
  }
}
// mtime+size 缓存：请求路径每轮都读，避免热路径反复 readFileSync
let stateCache = { mtimeMs: -1, size: -1, state: null };
function readState() {
  try {
    const st = fs.statSync(stateFile());
    if (stateCache.state && st.mtimeMs === stateCache.mtimeMs && st.size === stateCache.size) {
      return stateCache.state;
    }
    const state = readStateRaw();
    stateCache = { mtimeMs: st.mtimeMs, size: st.size, state };
    return state;
  } catch {
    return stateCache.state ?? defaultState();
  }
}
function invalidateStateCache() {
  stateCache = { mtimeMs: -1, size: -1, state: null };
}

// ---------------------------------------------------------------------------
// modelCatalog：provider 分组 → 全部模型（缓存 5 分钟；快照落盘兜底）
// ---------------------------------------------------------------------------
const CATALOG_TTL_MS = 5 * 60 * 1000;
let catalogCache = { at: 0, groups: null };

async function loadCatalog(ctx) {
  const now = Date.now();
  if (catalogCache.groups && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.groups;
  try {
    const sc = ctx?.get?.("sessionController");
    if (typeof sc?.modelCatalog !== "function") return catalogCache.groups ?? snapshotCatalog();
    const catalog = await sc.modelCatalog();
    const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
    if (groups.length > 0) {
      catalogCache = { at: now, groups };
      // 快照落盘（合并进现有 state，不覆盖其它字段）
      const snapshot = {};
      for (const g of groups) {
        const ids = (g.models ?? []).map((m) => m.id).filter((id) => typeof id === "string" && id.length > 0);
        if (typeof g.id === "string" && ids.length > 0) snapshot[g.id] = ids;
      }
      const state = readState();
      state.lastCatalog = snapshot;
      writeState(state);
      invalidateStateCache();
      return groups;
    }
  } catch {
    /* 目录不可用 → 落到快照 */
  }
  return catalogCache.groups ?? snapshotCatalog();
}
function snapshotCatalog() {
  const last = readState().lastCatalog ?? {};
  const groups = Object.entries(last).map(([id, models]) => ({
    id,
    models: (models ?? []).map((mid) => ({ id: mid, name: mid })),
  }));
  return groups.length > 0 ? groups : null;
}

// ---------------------------------------------------------------------------
// 纯逻辑（导出供单测）
// ---------------------------------------------------------------------------
/**
 * 把供应商池展开成模型候选列表（供应商顺序 → 目录内顺序）。
 * @param {Array<{id: string, models: Array<{id: string}>}>} groups modelCatalog 分组
 * @param {string[]} providerIds 选定的供应商（按用户顺序）
 * @returns {Array<{provider: string, model: string}>}
 */
export function buildPool(groups, providerIds) {
  const byId = new Map((groups ?? []).map((g) => [g.id, g]));
  const pool = [];
  const seen = new Set();
  for (const pid of providerIds ?? []) {
    const g = byId.get(pid);
    if (!g) continue; // 未知供应商跳过（调用方负责提示）
    for (const m of g.models ?? []) {
      if (typeof m?.id !== "string" || m.id.length === 0) continue;
      const key = `${pid}/${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push({ provider: pid, model: m.id });
    }
  }
  return pool;
}

/** 失败码是否触发转移（只认机器可路由 code）。 */
export function isRetryable(code, codes) {
  return typeof code === "string" && (codes ?? DEFAULT_RETRYABLE_CODES).includes(code);
}

/** 把 override 应用到一次请求配置上（丢掉继承的 reasoningEffort）。 */
export function applyRoute(resolved, target) {
  if (!target || !resolved) return resolved;
  if (resolved.provider === target.provider && resolved.model === target.model) return resolved;
  const { reasoningEffort: _drop, ...rest } = resolved;
  return { ...rest, provider: target.provider, model: target.model };
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------
/**
 * @param {object} ctx 插件上下文
 * @param {{enabled?: boolean, providers?: string[], retryableCodes?: string[], sticky?: boolean, maxFailoverAttempts?: number}} config
 * @param {{defineTool?: Function}} internals 测试缝（同官方 dsh-llm-retry 的 internals 模式）：
 *   工作区自测环境没有 @deepseek-ai/dsh-tools，从这里注入假 defineTool 以驱动真实接线。
 */
export async function apply(ctx, config = {}, internals = {}) {
  const cfg = {
    enabled: config?.enabled !== false,
    providers: Array.isArray(config?.providers) ? config.providers : [],
    retryableCodes: Array.isArray(config?.retryableCodes) && config.retryableCodes.length > 0
      ? config.retryableCodes
      : [...DEFAULT_RETRYABLE_CODES],
    sticky: config?.sticky === true,
    maxFailoverAttempts: Number.isFinite(config?.maxFailoverAttempts) && config.maxFailoverAttempts > 0
      ? Math.floor(config.maxFailoverAttempts)
      : 0,
  };
  const log = (msg) => {
    try {
      ctx?.logger?.info?.(`model-failover: ${msg}`);
    } catch { /* 日志失败不影响主流程 */ }
  };

  // 内存态：pending（一次故障转移的待生效目标）+ lastRoute（失败模型回溯用）
  //   pending: sessionId → { turn, step, target, tried:Set<"p/m">, switchCount, at }
  //   lastRoute: sessionId → { provider, model, turn, step }（agent/request 落笔）
  const pendingBySession = new Map();
  const lastRouteBySession = new Map();

  // agent/request 瀑布流：在有待生效目标 / sticky 粘滞时改写请求，并记录**最终出站路由**
  // （失败时回溯「哪个模型挂了」——注意必须记录改写后的值，下游默认值不是实际发出的模型）。
  ctx.on("agent/request", async ({ agent, turn, step }, next) => {
    const resolved = await next();
    try {
      const sessionId = agent?.session?.id;
      if (!sessionId || !resolved) return resolved;
      const state = readState();
      let outbound = resolved;
      if (cfg.enabled && !state.disabled) {
        // pending 优先（一次故障转移中的重试），其次 sticky 粘滞
        const cur = pendingBySession.get(sessionId);
        if (cur && (cur.turn === undefined || cur.turn === turn) && (cur.step === undefined || cur.step === step)) {
          outbound = applyRoute(resolved, cur.target);
        } else if (cfg.sticky) {
          const stickyTarget = state.stickyOverrides?.[sessionId];
          if (stickyTarget?.provider && stickyTarget?.model) outbound = applyRoute(resolved, stickyTarget);
        }
      }
      lastRouteBySession.set(sessionId, {
        provider: outbound.provider, model: outbound.model,
        turn, step, at: Date.now(),
      });
      return outbound;
    } catch {
      return resolved; // 任何异常都不影响正常请求
    }
  });

  // agent/request-error 瀑布流：官方 llm-retry（上游）同供应商重试耗尽后落到这里。
  ctx.on("agent/request-error", async (payload, next) => {
    const downstream = await next();
    try {
      if (!cfg.enabled) return downstream;
      const state = readState();
      if (state.disabled) return downstream;
      const { agent, provider, failure, retryPolicy, signal, turn, step } = payload ?? {};
      if (signal?.aborted) return downstream;
      const sessionId = agent?.session?.id;
      if (!sessionId || !failure) return downstream;
      // 有 retryPolicy 且官方决定同模型重试 → 让官方先试，本轮只记账
      if (retryPolicy && downstream?.kind === "retry") {
        return downstream;
      }
      if (!isRetryable(failure.code, cfg.retryableCodes)) return downstream;
      const providerIds = (Array.isArray(state.providers) && state.providers.length > 0)
        ? state.providers
        : cfg.providers;
      if (!providerIds || providerIds.length === 0) return downstream; // 未配池 → 不干预
      const groups = await loadCatalog(ctx);
      if (!groups) {
        log("modelCatalog 不可用且无快照，跳过本次故障转移");
        return downstream;
      }
      const pool = buildPool(groups, providerIds);
      if (pool.length === 0) {
        log(`池为空（providers=${JSON.stringify(providerIds)} 在目录中无模型）`);
        return downstream;
      }
      // 失败模型回溯：优先读会话 requestHeader（真实 harness 里最权威，记录的就是实际发出的配置）；
      // 退化到 agent/request 落笔的最终出站路由（单测/无 header 场景）。
      let failedModel;
      try {
        const header = agent.session?.requestHeader?.()?.config;
        if (header && header.provider === provider && typeof header.model === "string") failedModel = header.model;
      } catch { /* header 不可用 → 走 lastRoute */ }
      if (failedModel === undefined) {
        const last = lastRouteBySession.get(sessionId);
        failedModel = (last && last.turn === turn && last.step === step) ? last.model : undefined;
      }
      const cur = pendingBySession.get(sessionId);
      const sameSeries = cur && cur.turn === turn && cur.step === step;
      const tried = sameSeries ? cur.tried : new Set();
      tried.add(`${provider}/${failedModel ?? "*"}`);
      const switchCount = sameSeries ? cur.switchCount : 0;
      const cap = cfg.maxFailoverAttempts > 0 ? cfg.maxFailoverAttempts : pool.length;
      if (switchCount >= cap) return downstream;
      const candidate = pool.find((p) => !tried.has(`${p.provider}/${p.model}`));
      if (!candidate) {
        pendingBySession.delete(sessionId);
        recordEvent(ctx, { sessionId, from: `${provider}/${failedModel ?? "?"}`, to: null, code: failure.code, outcome: "pool-exhausted" });
        log(`池已试尽（${provider}/${failedModel ?? "?"} 失败：${failure.code}），交还原错误`);
        return downstream;
      }
      pendingBySession.set(sessionId, {
        turn, step, target: candidate, tried, switchCount: switchCount + 1, at: Date.now(),
      });
      if (cfg.sticky) {
        const nextState = readState();
        nextState.stickyOverrides = { ...(nextState.stickyOverrides ?? {}), [sessionId]: candidate };
        writeState(nextState);
        invalidateStateCache();
      }
      recordEvent(ctx, { sessionId, from: `${provider}/${failedModel ?? "?"}`, to: `${candidate.provider}/${candidate.model}`, code: failure.code, outcome: "failover" });
      log(`故障转移：${provider}/${failedModel ?? "?"} 失败（${failure.code}）→ 重试用 ${candidate.provider}/${candidate.model}`);
      return { kind: "retry" };
    } catch (error) {
      log(`故障转移处理异常（不干预本次）: ${String(error?.message ?? error)}`);
      return downstream;
    }
  });

  // 防泄漏：pending/lastRoute 超过 512 个会话时清理 1 小时前的旧条目
  ctx.on?.("turn/end", () => {
    if (pendingBySession.size <= 512 && lastRouteBySession.size <= 512) return;
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [k, v] of pendingBySession) if ((v.at ?? 0) < cutoff) pendingBySession.delete(k);
    for (const [k, v] of lastRouteBySession) if ((v.at ?? 0) < cutoff) lastRouteBySession.delete(k);
  });

  // ---------------------------------------------------------------------------
  // 运行时工具：model_failover（status / set / clear / enable / disable）
  // ---------------------------------------------------------------------------
  let defineTool = internals.defineTool ?? null;
  if (!defineTool) {
    try {
      const mod = await import("@deepseek-ai/dsh-tools");
      if (typeof mod?.defineTool === "function") defineTool = mod.defineTool;
    } catch { /* 无宿主依赖（工作区自测）→ 跳过注册 */ }
  }

  if (typeof ctx.inject === "function" && defineTool) {
    ctx.inject(["tools"], (tctx) => {
      const tools = tctx.get("tools");
      tools.register(defineTool({
        name: "model_failover",
        description: "模型故障自动转移：查看/设置故障转移池。set 传供应商列表（单个或多个，来自 list_models 的 provider 分组名），池=这些供应商下的全部模型；请求失败时自动按池顺序切换重试。",
        parameters: {
          action: { type: "string", required: true, description: "status（查看）/ set（设置池）/ clear（清空运行时池）/ enable / disable" },
          providers: { type: "array", description: "set 时必填：供应商 id 列表（按顺序，如 [\"wb\",\"agnes\"]）" },
        },
        output: {
          schema: { type: "string" },
          render(args, value) {
            return [{ type: "text", text: String(value) }];
          },
        },
        async execute(args) {
          const action = String(args?.action ?? "status").trim().toLowerCase();
          const state = readState();
          if (action === "status") {
            const providerIds = (Array.isArray(state.providers) && state.providers.length > 0) ? state.providers : cfg.providers;
            const groups = await loadCatalog(ctx);
            const pool = groups ? buildPool(groups, providerIds) : [];
            const poolDesc = providerIds.length === 0
              ? "未配置（故障转移不生效）"
              : `${providerIds.join(" → ")}（${pool.length} 个候选模型${groups ? "" : "，目录不可用仅剩快照"}）`;
            const stickyCount = Object.keys(state.stickyOverrides ?? {}).length;
            const events = (state.events ?? []).slice(-8).reverse()
              .map((e) => `  - ${new Date(e.time).toLocaleString("zh-CN")} ${e.sessionId?.slice(0, 12)}… ${e.from} [${e.code}] → ${e.to ?? "(池尽)"} ${e.outcome}`)
              .join("\n");
            return [
              `状态：${state.disabled ? "⛔ 运行时已停用" : cfg.enabled ? "✅ 启用" : "⛔ 配置停用"}`,
              `池：${poolDesc}`,
              `触发码：${cfg.retryableCodes.join(", ")}`,
              `粘滞模式：${cfg.sticky ? `开（${stickyCount} 个会话有粘滞目标）` : "关（仅当次故障内转移）"}`,
              `单次故障转移上限：${cfg.maxFailoverAttempts > 0 ? cfg.maxFailoverAttempts : "整个池子"}`,
              events ? `最近事件：\n${events}` : "最近事件：（无）",
            ].join("\n");
          }
          if (action === "set") {
            const providers = (Array.isArray(args?.providers) ? args.providers : [])
              .map((p) => String(p).trim()).filter(Boolean);
            if (providers.length === 0) return "设置失败：providers 必填（供应商 id 列表，可先调 list_models 查看分组名）";
            const groups = await loadCatalog(ctx);
            const known = new Set((groups ?? []).map((g) => g.id));
            const unknown = providers.filter((p) => !known.has(p));
            const pool = groups ? buildPool(groups, providers) : [];
            const nextState = { ...state, providers };
            writeState(nextState);
            invalidateStateCache();
            return [
              `✅ 运行时池已设置：${providers.join(" → ")}`,
              groups ? `候选模型 ${pool.length} 个：\n${pool.map((p) => `  - ${p.provider}/${p.model}`).join("\n")}` : "（目录不可用，已保存；目录可用后自动展开）",
              unknown.length > 0 ? `⚠️ 目录中未找到的供应商（已保留，可能稍后可用）：${unknown.join(", ")}` : "",
            ].filter(Boolean).join("\n");
          }
          if (action === "clear") {
            const nextState = { ...state, providers: [], stickyOverrides: {} };
            writeState(nextState);
            invalidateStateCache();
            pendingBySession.clear();
            return "✅ 已清空运行时池与粘滞目标（回退到插件 config.providers；为空则故障转移不生效）";
          }
          if (action === "enable" || action === "disable") {
            const nextState = { ...state, disabled: action === "disable" };
            writeState(nextState);
            invalidateStateCache();
            return `✅ 故障转移已${action === "disable" ? "停用" : "启用"}（运行时闸门）`;
          }
          return `未知 action：${action}（可用：status / set / clear / enable / disable）`;
        },
      }));
      log("model_failover 工具已注册");
    });
  }
  // ---------------------------------------------------------------------------
  // Web UI 控制台（右下角模型选择器左侧的「故障转移」入口）：
  // Client 半边（client.js）注册进 conversation.input.right，数据与操作走这组同源路由。
  // 与 model_failover 工具共用同一份状态读写，不存在两套逻辑。
  // ---------------------------------------------------------------------------
  const sendJson = (res, status, body) => {
    try {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    } catch { /* 连接已断 → 忽略 */ }
  };
  const readJsonBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    return raw ? JSON.parse(raw) : {};
  };
  /** 组装给 UI 的快照（池 = 所选供应商全部模型）。 */
  const uiSnapshot = async () => {
    const state = readState();
    const providerIds = (Array.isArray(state.providers) && state.providers.length > 0) ? state.providers : cfg.providers;
    const groups = (await loadCatalog(ctx)) ?? [];
    const pool = buildPool(groups, providerIds);
    const providers = groups.map((g) => ({
      id: String(g.id ?? ""),
      name: String(g.name ?? g.id ?? ""),
      models: Array.isArray(g.models) ? g.models.length : 0,
    })).filter((p) => p.id.length > 0);
    return {
      ok: true,
      enabled: cfg.enabled && !state.disabled,
      configEnabled: cfg.enabled,
      runtimeDisabled: state.disabled === true,
      providers: providerIds,
      configProviders: cfg.providers,
      pool,
      providersCatalog: providers,
      sticky: cfg.sticky,
      retryableCodes: cfg.retryableCodes,
      maxFailoverAttempts: cfg.maxFailoverAttempts,
      events: (state.events ?? []).slice(-5),
    };
  };
  ctx.inject(["webServer"], (wctx) => {
    const webServer = wctx.get("webServer");
    if (!webServer?.register) return;
    webServer.register({
      kind: "exact",
      path: "/api/model-failover/status",
      handler: async (req, res) => {
        try {
          if ((req.method ?? "GET") !== "GET") return sendJson(res, 405, { ok: false, error: { code: "METHOD", message: "Method Not Allowed" } });
          return sendJson(res, 200, await uiSnapshot());
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: { code: "INTERNAL", message: String(error?.message ?? error) } });
        }
      },
    });
    webServer.register({
      kind: "exact",
      path: "/api/model-failover/set",
      handler: async (req, res) => {
        try {
          if ((req.method ?? "POST") !== "POST") return sendJson(res, 405, { ok: false, error: { code: "METHOD", message: "Method Not Allowed" } });
          const body = await readJsonBody(req);
          const providers = (Array.isArray(body?.providers) ? body.providers : [])
            .map((p) => String(p).trim()).filter(Boolean);
          writeState({ ...readState(), providers });
          invalidateStateCache();
          return sendJson(res, 200, { ok: true, ...(await uiSnapshot()) });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: { code: "SET", message: String(error?.message ?? error) } });
        }
      },
    });
    webServer.register({
      kind: "exact",
      path: "/api/model-failover/clear",
      handler: async (req, res) => {
        try {
          if ((req.method ?? "POST") !== "POST") return sendJson(res, 405, { ok: false, error: { code: "METHOD", message: "Method Not Allowed" } });
          writeState({ ...readState(), providers: [], stickyOverrides: {} });
          invalidateStateCache();
          pendingBySession.clear();
          return sendJson(res, 200, { ok: true, ...(await uiSnapshot()) });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: { code: "CLEAR", message: String(error?.message ?? error) } });
        }
      },
    });
    webServer.register({
      kind: "exact",
      path: "/api/model-failover/toggle",
      handler: async (req, res) => {
        try {
          if ((req.method ?? "POST") !== "POST") return sendJson(res, 405, { ok: false, error: { code: "METHOD", message: "Method Not Allowed" } });
          const body = await readJsonBody(req);
          const enabled = body?.enabled !== false;
          writeState({ ...readState(), disabled: !enabled });
          invalidateStateCache();
          return sendJson(res, 200, { ok: true, ...(await uiSnapshot()) });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: { code: "TOGGLE", message: String(error?.message ?? error) } });
        }
      },
    });
    log("Web UI 路由已注册 (/api/model-failover/status|set|clear|toggle)");
  });

  log(`已接线（enabled=${cfg.enabled}, config池=${cfg.providers.length} 个供应商, sticky=${cfg.sticky}）`);
}

/** 记录转移事件（内存 + state.events 最近 20 条）。 */
function recordEvent(ctx, event) {
  try {
    const state = readState();
    const events = [...(state.events ?? []), { time: Date.now(), ...event }].slice(-20);
    writeState({ ...state, events });
    invalidateStateCache();
  } catch { /* 事件记录失败不影响转移 */ }
}

// 纯逻辑导出（单测用）
export const _internals = { DEFAULT_RETRYABLE_CODES, applyRoute, buildPool, isRetryable };
