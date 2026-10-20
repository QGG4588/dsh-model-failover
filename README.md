# dsh-model-failover — 模型故障自动转移

> DeepSeek Harness 插件：模型请求失败时，自动切换到「所选供应商池」中的下一个模型重试。

## 它解决什么

DSH 官方模型选择是「一次选定、失败就报错」。官方 `dsh-llm-retry` 只在**同一供应商**内重试——
如果供应商整体限流/配额耗尽/宕掉，重试 5 次后这一轮仍然失败。

本插件在**供应商之间**做故障转移：

- **池 = 所选供应商下的全部模型**：只选一个供应商 → 该供应商内所有模型轮询；选多个 → 按顺序跨供应商池轮询。
- **失败即切**：`RATE_LIMIT` / `QUOTA` / `TIMEOUT` / `SERVER` / `TRANSPORT` / `EMPTY_RESPONSE` 等
  可配置的机器可路由 code 触发；每个候选模型只试一次，绝不重复试同一个。
- **池尽即还原**：整个池都失败时交还原错误，不掩盖真实故障。
- **运行时可控**：`model_failover` 工具随时 `status / set / clear / enable / disable`，不用改配置重启。
- **可粘滞**：`sticky: true` 时转移后该会话持续使用新模型；默认只转移当次故障。

## 机制（与 DSH 官方扩展点对齐）

1. `agent/request-error` 瀑布流（官方重试插件同款扩展点）：上游 `dsh-llm-retry` 同供应商重试耗尽后
   返回 `undefined`，本插件接住失败 → 从池中挑下一个未试过的模型 → 返回 `{ kind: "retry" }`，
   agent-loop 重新 `prepareRequest` 并重发。
2. `agent/request` 瀑布流：把待生效目标写进本次请求的 provider/model，成为实际发送的模型
   （与 dsh-session-conductor 的成员模型切换同一模式）。
3. 失败分类只认 `failure.code`（机器可路由），绝不解析报错文本。
4. 状态存 `<DSH_HOME>/model-failover/state.json`：运行时池、粘滞目标、modelCatalog 快照、最近事件。
   不写会话事件（Session 拒绝未知 type 的非 ignorable 事件）。

## 安装

本仓库是一个 Host-only bundle（无第三方依赖、无需构建）：

```
dsh-model-failover/
├── index.js            # 宿主插件主体
├── cordis.patch.yml    # bundle patch（insert 一行）
├── package.json        # dsh.bundle.patch 声明
├── locale/{en,zh}.json # 插件市场显示名/描述
└── icon.svg
```

通过 DSH 的 Plugin Manager 安装该目录（`install_bundle`，target 传本目录绝对路径），
或把目录放进 profile 的 `node_modules/` 并在 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-model-failover
      name: dsh-model-failover
      config: {}
```

重启 DSH 生效。

## 配置（cordis.patch.yml 行 config，全部有默认值）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `providers` | `[]` | 默认供应商池（按顺序）；空 = 用 `model_failover set` 运行时设置 |
| `retryableCodes` | `RATE_LIMIT, QUOTA, ACCOUNT_QUOTA, SERVER, TIMEOUT, TRANSPORT, EMPTY_RESPONSE, NO_ADAPTER` | 触发转移的失败码 |
| `sticky` | `false` | 转移后粘滞该会话直到 `clear`；false = 仅当次故障内转移 |
| `maxFailoverAttempts` | `0` | 单次故障最多转移几个候选（0 = 整个池子） |

## 熔断（抗抖动）

单个模型偶发失败不立刻拉黑，但持续失败会被"熔断"一段时间，避免每次请求都先撞一遍坏模型：

- **模型级**：`failureThreshold`（默认 2）次失败发生在 `burstWindowMs`（默认 300s）窗口内 → 该路由冷却 `circuitCooldownMs`（默认 60s），期间池候选自动跳过它；
- **供应商级**：同一供应商下已有 `providerThreshold`（默认 2）个模型同时熔断 → 该供应商池内全部模型一起冷却（整个平台挂掉时不再逐个撞）；
- **主动绕行**：请求命中已熔断路由时，`agent/request` 直接改道到池中第一个健康模型，不必再失败一次（`preemptiveSwitch`，默认开）；
- **自动恢复**：冷却到期自动复活；`llm/stream` 观察到成功终态时清除该路由熔断并打上"今日可用"标记；
- 全部候选都在熔断时仍按池顺序尝试（不把用户卡死）。

状态持久化在 `state.json` 的 `circuits` / `success`，重启后冷却仍有效。
## 运行时工具 `model_failover`

| action | 参数 | 作用 |
|---|---|---|
| `status` | — | 查看开关/池（含候选模型列表）/触发码/最近 8 条转移事件 |
| `set` | `providers: ["wb","agnes"]` | 设置运行时池（优先于 config.providers），立即生效 |
| `clear` | — | 清空运行时池与粘滞目标，回退配置池 |
| `enable` / `disable` | — | 运行时总闸 |

示例：

```text
model_failover set providers=["wb","agnes"]   → 池 = wb 全部模型 + agnes 全部模型（按此顺序）
model_failover status                          → 池 6 个候选：wb/cn:a, wb/cn:b, … agnes/global:x
```

## 图形界面（输入框右下角）

插件自带浏览器半边：在输入框右下角、官方「模型选择器」左侧有一个 **⇄ 故障转移** 按钮，
点开后可以：

- 勾选一个或多个供应商（池 = 所选供应商内的全部模型，实时显示每个供应商的模型数）
- 保存 / 清空 / 停用·启用，点一下立即生效（与 `model_failover` 工具共用同一份状态）
- 查看池内每个模型的状态徽标（🟢 今日可用 / 🔴 熔断冷却中带倒计时 / ⚪ 未试）与熔断策略、最近几次转移事件

数据与操作走宿主同源路由 `GET /api/model-failover/status`、`POST /api/model-failover/{set,clear,toggle}`。
新增/修改 Client 代码后需要重启 DSH 并刷新页面（桌面端不做热加载）。

## 与其它插件的协同

- **dsh-llm-retry（官方）**：天然协同——上游先同供应商重试（自带退避），耗尽后本插件接住做跨供应商转移。
- **dsh-session-conductor（成员模型切换）**：两者都在 `agent/request` 改写模型。本插件在有待生效转移目标
  或 sticky 粘滞时生效；显式成员模型不会被无故障时改写（无 pending 时不干预）。

## 已知边界

- 池成员来自 `modelCatalog`；目录不可用时用最近的落盘快照（重启后仍可用）。
- 图片消息 + 纯文本模型：本插件不检查候选模型的输入模态（v1），如池内含纯文本模型可能在该轮被拒。
- 转移发生在同一步内，可能增加该步耗时（每个候选一次完整请求尝试 + 官方退避）。
- 不做「定时轮询」：只有失败才转移（按设计）。

## 测试

```bash
node --test test/unit.mjs
```

覆盖：池展开（单/多供应商、去重、未知跳过）、失败码过滤、路由改写、全链路
（失败 → 转移 → 重试 → 池尽还原）、运行时 set 立即生效、sticky/非 sticky 行为、状态持久化 + 快照兜底。

## License

MIT

