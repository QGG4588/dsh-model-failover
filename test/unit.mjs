// dsh-model-failover 单元测试（工作区自测：无宿主依赖，伪 ctx 驱动真实 apply 接线）
// 覆盖：buildPool / isRetryable / applyRoute 纯逻辑 + agent/request-error → agent/request 全链路
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-failover-test-"));

const mod = await import("../index.js");
const { buildPool, isRetryable, applyRoute, _internals } = mod;

// ---------------------------------------------------------------------------
// 纯逻辑
// ---------------------------------------------------------------------------
const GROUPS = [
  { id: "wb", models: [{ id: "cn:a" }, { id: "cn:b" }] },
  { id: "agnes", models: [{ id: "agnes-1" }, { id: "agnes-2" }] },
];

test("buildPool: 单供应商 → 该供应商全部模型", () => {
  assert.deepEqual(buildPool(GROUPS, ["wb"]), [
    { provider: "wb", model: "cn:a" },
    { provider: "wb", model: "cn:b" },
  ]);
});

test("buildPool: 多供应商 → 按顺序拼接", () => {
  assert.deepEqual(buildPool(GROUPS, ["wb", "agnes"]), [
    { provider: "wb", model: "cn:a" },
    { provider: "wb", model: "cn:b" },
    { provider: "agnes", model: "agnes-1" },
    { provider: "agnes", model: "agnes-2" },
  ]);
});

test("buildPool: 未知供应商跳过、去重", () => {
  assert.deepEqual(buildPool(GROUPS, ["nope", "wb", "wb"]), [
    { provider: "wb", model: "cn:a" },
    { provider: "wb", model: "cn:b" },
  ]);
});

test("buildPool: 空目录/空列表 → 空池", () => {
  assert.deepEqual(buildPool(null, ["wb"]), []);
  assert.deepEqual(buildPool(GROUPS, []), []);
});

test("isRetryable: 只认机器可路由 code", () => {
  assert.equal(isRetryable("RATE_LIMIT"), true);
  assert.equal(isRetryable("QUOTA"), true);
  assert.equal(isRetryable("SERVER"), true);
  assert.equal(isRetryable("TIMEOUT"), true);
  assert.equal(isRetryable("TRANSPORT"), true);
  assert.equal(isRetryable("EMPTY_RESPONSE"), true);
  assert.equal(isRetryable("INVALID_CREDENTIAL"), false); // 恶性凭证不重试
  assert.equal(isRetryable("CONTEXT_WINDOW_EXCEEDED"), false);
  assert.equal(isRetryable(undefined), false);
  assert.equal(isRetryable("WHATEVER", ["WHATEVER"]), true); // 自定义码集
});

test("applyRoute: 改写 provider/model 并丢 reasoningEffort", () => {
  const resolved = { provider: "wb", model: "cn:a", reasoningEffort: "high", tools: [1] };
  const out = applyRoute(resolved, { provider: "agnes", model: "agnes-1" });
  assert.deepEqual(out, { provider: "agnes", model: "agnes-1", tools: [1] });
  assert.deepEqual(applyRoute(resolved, { provider: "wb", model: "cn:a" }), resolved);
  assert.equal(applyRoute(resolved, null), resolved);
});

// ---------------------------------------------------------------------------
// 接线级测试：伪 ctx 驱动真实 apply，走 agent/request-error → agent/request 全链路
// ---------------------------------------------------------------------------
function fakeCtx({ catalog } = {}) {
  const hooks = new Map();
  const tools = { registered: [], register(t) { this.registered.push(t); } };
  const fakeDefineTool = (spec) => ({ ...spec, execute: spec.execute });
  const ctx = {
    on(name, fn) { hooks.set(name, fn); return () => {}; },
    inject(_deps, fn) { fn({ get: () => tools }); },
    get(key) {
      if (key === "sessionController") {
        return { modelCatalog: catalog ? async () => catalog : undefined };
      }
      return undefined;
    },
    logger: { info() {}, warn() {} },
    _hooks: hooks,
    _tools: tools,
  };
  return { ctx, internals: { defineTool: fakeDefineTool } };
}

/** 模拟 agent-loop 的 step 循环：prepareRequest（走 agent/request 瀑布）→ 失败 → request-error。 */
async function runStep(ctx, { session, failModels, failCode = "RATE_LIMIT", initialRoute, turn = 1, step = 1 }) {
  const requestErrorHook = ctx._hooks.get("agent/request-error");
  const agentRequestHook = ctx._hooks.get("agent/request");
  let currentRoute = { ...initialRoute };
  const attempts = [];
  for (let i = 0; i < 12; i++) {
    attempts.push({ ...currentRoute });
    // agent/request：解析 + 记录路由（真实插件在此改写）
    let resolved = await agentRequestHook({ agent: session.agent, turn, step }, async () => ({ ...currentRoute }));
    // 官方 installModelSelection 也在同一瀑布里（这里简化为直接透传）
    if (resolved !== currentRoute) currentRoute = { ...resolved };
    attempts[attempts.length - 1] = { ...currentRoute };
    const failed = failModels.includes(`${currentRoute.provider}/${currentRoute.model}`);
    if (!failed) return { ok: true, attempts, finalRoute: currentRoute };
    // 请求失败 → agent/request-error 瀑布（下游 = 官方 retry 无策略 → undefined）
    const action = await requestErrorHook(
      { agent: session.agent, provider: currentRoute.provider, failure: { message: "x", code: failCode }, turn, step, signal: undefined },
      async () => undefined,
    );
    if (action?.kind !== "retry") return { ok: false, attempts, finalRoute: currentRoute };
  }
  return { ok: false, attempts, finalRoute: currentRoute };
}

const SESSION = { agent: { session: { id: "sess-1" } } };
let sessionCounter = 0;
function freshSession() {
  return { agent: { session: { id: `sess-${++sessionCounter}` } } };
}

test("接线: 单供应商池尽后交还原错误（池=2 个模型全挂 → 不再重复尝试）", async () => {
  const { ctx, internals } = fakeCtx({ catalog: { groups: GROUPS } });
  const session = freshSession();
  await mod.apply(ctx, { providers: ["wb"] }, internals);
  const r = await runStep(ctx, {
    session,
    initialRoute: { provider: "wb", model: "cn:a" },
    failModels: ["wb/cn:a", "wb/cn:b"],
  });
  assert.equal(r.ok, false); // 池只有 2 个，全挂 → 交还原错误（不算成功）
  assert.equal(r.attempts.length, 2); // a → b，然后不再有第 3 个候选
});

test("接线: 单供应商失败 → 池内轮询直到成功", async () => {
  const { ctx, internals } = fakeCtx({ catalog: { groups: GROUPS } });
  const session = freshSession();
  await mod.apply(ctx, { providers: ["wb"] }, internals);
  const r = await runStep(ctx, {
    session,
    initialRoute: { provider: "wb", model: "cn:a" },
    failModels: ["wb/cn:a"], // 只有 a 挂，b 成功
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.attempts, [
    { provider: "wb", model: "cn:a" },
    { provider: "wb", model: "cn:b" },
  ]);
});

test("接线: 多供应商跨池转移", async () => {
  const { ctx, internals } = fakeCtx({ catalog: { groups: GROUPS } });
  const session = freshSession();
  await mod.apply(ctx, { providers: ["wb", "agnes"] }, internals);
  const r = await runStep(ctx, {
    session,
    initialRoute: { provider: "wb", model: "cn:a" },
    failModels: ["wb/cn:a", "wb/cn:b", "agnes/agnes-1"],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.attempts, [
    { provider: "wb", model: "cn:a" },
    { provider: "wb", model: "cn:b" },
    { provider: "agnes", model: "agnes-1" },
    { provider: "agnes", model: "agnes-2" },
  ]);
});

test("接线: 池尽交还原错误（重复失败同一池）", async () => {
  const { ctx, internals } = fakeCtx({ catalog: { groups: GROUPS } });
  const session = freshSession();
  await mod.apply(ctx, { providers: ["wb"] }, internals);
  const r = await runStep(ctx, {
    session,
    initialRoute: { provider: "wb", model: "cn:a" },
    failModels: ["wb/cn:a", "wb/cn:b", "wb/cn:a"], // 全挂（第3次不会再转移到同一集合外）
  });
  assert.equal(r.ok, false);
  assert.equal(r.attempts.length, 2);
});

test("接线: 不可重试 code 不干预", async () => {
  const { ctx, internals } = fakeCtx({ catalog: { groups: GROUPS } });
  await mod.apply(ctx, { providers: ["wb", "agnes"] }, internals);
  const requestErrorHook = ctx._hooks.get("agent/request-error");
  const action = await requestErrorHook(
    { agent: SESSION.agent, provider: "wb", failure: { message: "x", code: "INVALID_CREDENTIAL" }, turn: 1, step: 1 },
    async () => undefined,
  );
  assert.equal(action, undefined);
});

test("接线: 未配池不干预", async () => {
  const { ctx, internals } = fakeCtx({ catalog: { groups: GROUPS } });
  await mod.apply(ctx, {}, internals);
  const requestErrorHook = ctx._hooks.get("agent/request-error");
  const action = await requestErrorHook(
    { agent: SESSION.agent, provider: "wb", failure: { message: "x", code: "RATE_LIMIT" }, turn: 1, step: 1 },
    async () => undefined,
  );
  assert.equal(action, undefined);
});

test("接线: model_failover 工具 set/status/clear", async () => {
  const { ctx, internals } = fakeCtx({ catalog: { groups: GROUPS } });
  await mod.apply(ctx, {}, internals);
  const tool = ctx._tools.registered.find((t) => t.name === "model_failover");
  assert.ok(tool, "model_failover 工具应注册");
  const out1 = await tool.execute({ action: "set", providers: ["wb", "agnes"] });
  assert.match(out1, /✅ 运行时池已设置/);
  assert.match(out1, /候选模型 4 个/);
  const out2 = await tool.execute({ action: "status" });
  assert.match(out2, /wb → agnes/);
  const out3 = await tool.execute({ action: "clear" });
  assert.match(out3, /✅ 已清空/);
  const out4 = await tool.execute({ action: "status" });
  assert.match(out4, /未配置/);
});

test("接线: 运行时 set 的池立即生效", async () => {
  const { ctx, internals } = fakeCtx({ catalog: { groups: GROUPS } });
  const session = freshSession();
  await mod.apply(ctx, {}, internals);
  const tool = ctx._tools.registered.find((t) => t.name === "model_failover");
  await tool.execute({ action: "set", providers: ["agnes"] });
  const r = await runStep(ctx, {
    session,
    initialRoute: { provider: "wb", model: "cn:a" }, // 不在池里，但失败仍转移
    failModels: ["wb/cn:a"],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.attempts, [
    { provider: "wb", model: "cn:a" },
    { provider: "agnes", model: "agnes-1" },
  ]);
});

test("接线: sticky=false 时重试成功后新回合回落默认模型", async () => {
  const { ctx, internals } = fakeCtx({ catalog: { groups: GROUPS } });
  const session = freshSession();
  await mod.apply(ctx, { providers: ["wb", "agnes"] }, internals);
  const r = await runStep(ctx, { session, initialRoute: { provider: "wb", model: "cn:a" }, failModels: ["wb/cn:a"], turn: 7, step: 2 });
  assert.equal(r.ok, true);
  // 新回合（不同 turn/step）→ pending 不命中 → 回落
  const agentRequestHook = ctx._hooks.get("agent/request");
  const resolved = await agentRequestHook({ agent: session.agent, turn: 8, step: 1 }, async () => ({ provider: "wb", model: "cn:a" }));
  assert.deepEqual(resolved, { provider: "wb", model: "cn:a" });
});

test("接线: 状态文件持久化（重启后快照兜底）", async () => {
  const home = process.env.DSH_HOME;
  const { ctx: ctx1, internals } = fakeCtx({ catalog: { groups: GROUPS } });
  await mod.apply(ctx1, {}, internals);
  const tool1 = ctx1._tools.registered.find((t) => t.name === "model_failover");
  await tool1.execute({ action: "set", providers: ["wb"] });
  // 模拟重启：新 ctx，无 catalog（sessionController 不可用）→ 快照兜底
  const { ctx: ctx2, internals: internals2 } = fakeCtx({});
  await mod.apply(ctx2, {}, internals2);
  const tool2 = ctx2._tools.registered.find((t) => t.name === "model_failover");
  const out = await tool2.execute({ action: "status" });
  assert.match(out, /wb/); // 快照里还有 wb 的模型
  const r = await runStep(ctx2, {
    session: freshSession(),
    initialRoute: { provider: "wb", model: "cn:a" },
    failModels: ["wb/cn:a"],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.attempts, [
    { provider: "wb", model: "cn:a" },
    { provider: "wb", model: "cn:b" },
  ]);
  process.env.DSH_HOME = home;
});

// ---------------------------------------------------------------------------
// Web UI 路由（右下角面板后端）：status / set / clear / toggle
// ---------------------------------------------------------------------------
function fakeCtxWithWeb({ catalog } = {}) {
  const hooks = new Map();
  const routes = new Map();
  const tools = { registered: [], register(t) { this.registered.push(t); } };
  const fakeDefineTool = (spec) => ({ ...spec });
  const webServer = {
    register(route) { routes.set(route.path, route); },
  };
  const ctx = {
    on(name, fn) { hooks.set(name, fn); return () => {}; },
    inject(deps, fn) {
      // 同时满足 tools / webServer 两个 inject 块
      fn({
        get(key) {
          if (key === "tools") return tools;
          if (key === "webServer") return webServer;
          return undefined;
        },
      });
    },
    get(key) {
      if (key === "sessionController") {
        return { modelCatalog: catalog ? async () => catalog : undefined };
      }
      return undefined;
    },
    logger: { info() {}, warn() {} },
    _hooks: hooks,
    _routes: routes,
    _tools: tools,
  };
  return { ctx, internals: { defineTool: fakeDefineTool } };
}

function fakeRes() {
  return {
    status: 0,
    body: "",
    writeHead(code) { this.status = code; },
    end(s) { this.body = s; },
  };
}

async function callRoute(ctx, path, { method = "GET", body } = {}) {
  const route = ctx._routes.get(path);
  assert.ok(route, `route ${path} 应注册`);
  const req = {
    method,
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); },
  };
  const res = fakeRes();
  await route.handler(req, res);
  return { status: res.status, json: JSON.parse(res.body || "{}") };
}

test("Web UI: status 返回目录/池/事件", async () => {
  const { ctx, internals } = fakeCtxWithWeb({ catalog: { groups: GROUPS } });
  await mod.apply(ctx, {}, internals);
  const { status, json } = await callRoute(ctx, "/api/model-failover/status");
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.deepEqual(json.providersCatalog.map((p) => p.id), ["wb", "agnes"]);
  assert.equal(json.providersCatalog[0].models, 2);
});

test("Web UI: set 生效并回传池", async () => {
  const { ctx, internals } = fakeCtxWithWeb({ catalog: { groups: GROUPS } });
  await mod.apply(ctx, {}, internals);
  const { status, json } = await callRoute(ctx, "/api/model-failover/set", { method: "POST", body: { providers: ["wb"] } });
  assert.equal(status, 200);
  assert.deepEqual(json.providers, ["wb"]);
  assert.deepEqual(json.pool, [
    { provider: "wb", model: "cn:a" },
    { provider: "wb", model: "cn:b" },
  ]);
  // 后续 status 读到的是同一份状态
  const snap = await callRoute(ctx, "/api/model-failover/status");
  assert.deepEqual(snap.json.providers, ["wb"]);
});

test("Web UI: toggle / clear", async () => {
  const { ctx, internals } = fakeCtxWithWeb({ catalog: { groups: GROUPS } });
  await mod.apply(ctx, {}, internals);
  const off = await callRoute(ctx, "/api/model-failover/toggle", { method: "POST", body: { enabled: false } });
  assert.equal(off.json.enabled, false);
  assert.equal(off.json.runtimeDisabled, true);
  const on = await callRoute(ctx, "/api/model-failover/toggle", { method: "POST", body: { enabled: true } });
  assert.equal(on.json.enabled, true);
  await callRoute(ctx, "/api/model-failover/set", { method: "POST", body: { providers: ["agnes"] } });
  const cleared = await callRoute(ctx, "/api/model-failover/clear", { method: "POST", body: {} });
  assert.deepEqual(cleared.json.providers, []);
  assert.deepEqual(cleared.json.pool, []);
});

test("Web UI: 非 POST 拒绝（405）", async () => {
  const { ctx, internals } = fakeCtxWithWeb({ catalog: { groups: GROUPS } });
  await mod.apply(ctx, {}, internals);
  const { status } = await callRoute(ctx, "/api/model-failover/set", { method: "GET" });
  assert.equal(status, 405);
});
