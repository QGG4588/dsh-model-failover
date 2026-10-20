// dsh-model-failover — 浏览器半边（Web UI）
// 在输入框右下角、官方模型选择器左侧插入「故障转移」入口：
//   · 点开可勾选一个或多个供应商（池 = 所选供应商内的全部模型）
//   · 保存 / 清空 / 停用·启用，全部即时生效
//   · 显示当前池大小与最近几次转移事件
// 数据与操作全部走宿主同源路由 /api/model-failover/*，与 model_failover 工具共用同一份状态。
window.__ModuleLoader__.load({
  id: 'dsh-model-failover',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'modelFailover';

    const CSS = [
      '.mf_root{position:relative;display:flex;align-items:center}',
      '.mf_btn{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;line-height:1}',
      '.mf_btn:hover{color:var(--dsw-alias-label-primary)}',
      '.mf_btn.mf_on{border-color:var(--dsw-state-success-primary,#34a853);color:var(--dsw-state-success-primary,#34a853)}',
      '.mf_badge{font-size:11px;opacity:.85}',
      '.mf_mask{position:fixed;inset:0;z-index:1000;background:transparent}',
      '.mf_panel{position:absolute;right:0;bottom:36px;z-index:1001;width:310px;max-height:440px;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;background:var(--dsw-alias-bg-layer-3);box-shadow:0 12px 40px rgba(0,0,0,.35);font-size:12px;color:var(--dsw-alias-label-primary)}',
      '.mf_head{display:flex;align-items:center;justify-content:space-between}',
      '.mf_title{font-size:13px;font-weight:600}',
      '.mf_x{background:0 0;border:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:13px;padding:2px 6px}',
      '.mf_hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.mf_list{display:flex;flex-direction:column;gap:2px;max-height:190px;overflow:auto}',
      '.mf_row{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:6px;cursor:pointer}',
      '.mf_row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.mf_name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mf_count{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.mf_actions{display:flex;gap:8px;flex-wrap:wrap}',
      '.mf_act{flex:1;min-width:80px;height:28px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}',
      '.mf_act.mf_primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.mf_err{font-size:11px;color:var(--dsw-state-error-primary,#e5484d);white-space:pre-wrap}',
      '.mf_events{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;line-height:15px;max-height:70px;overflow:auto;border-top:.5px dashed var(--dsw-alias-border-l2);padding-top:6px}',
      '.mf_mrow{display:flex;align-items:center;gap:6px;font-size:11px;padding:2px 4px;border-radius:4px}',
      '.mf_mrow:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.mf_mbadge{width:14px;text-align:center}',
      '.mf_mname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
      '.mf_mstat{font-size:10px;color:var(--dsw-alias-label-tertiary)}',
    ].join('');

    function api(path, body) {
      const init = body === undefined
        ? { credentials: 'same-origin' }
        : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
      return fetch('/api/model-failover/' + path, init).then(async (r) => {
        let j = {};
        try { j = await r.json(); } catch (e) { /* 非 JSON */ }
        if (!r.ok || j.ok === false) {
          const msg = j && j.error && j.error.message ? j.error.message : 'HTTP ' + r.status;
          throw new Error(msg);
        }
        return j;
      });
    }

    function FailoverSeat() {
      const [open, setOpen] = React.useState(false);
      const [status, setStatus] = React.useState(null);
      const [draft, setDraft] = React.useState([]);
      const [busy, setBusy] = React.useState(false);
      const [err, setErr] = React.useState('');

      const refresh = React.useCallback(async () => {
        try {
          const s = await api('status');
          setStatus(s);
          setDraft(Array.isArray(s.providers) ? s.providers : []);
          setErr('');
        } catch (e) {
          setErr(String((e && e.message) || e));
        }
      }, []);

      React.useEffect(() => { if (open) refresh(); }, [open, refresh]);

      const run = async (fn) => {
        setBusy(true);
        setErr('');
        try {
          await fn();
          await refresh();
        } catch (e) {
          setErr(String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      };

      const toggleProvider = (id) => {
        setDraft((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
      };

      const enabled = !!(status && status.enabled);
      const poolCount = status && Array.isArray(status.pool) ? status.pool.length : 0;
      const catalog = (status && status.providersCatalog) || [];
      const events = (status && status.events) || [];

      const button = h('button', {
        type: 'button',
        className: 'mf_btn' + (enabled && poolCount > 0 ? ' mf_on' : ''),
        title: '模型故障自动转移',
        onClick: () => setOpen((v) => !v),
      }, h('span', null, '⇄'), h('span', null, '故障转移'), status ? h('span', { className: 'mf_badge' }, poolCount > 0 ? String(poolCount) : '—') : null);

      if (!open) return h('div', { className: 'mf_root' }, h('style', null, CSS), button);

      const rows = catalog.map((p) => h('label', { key: p.id, className: 'mf_row' },
        h('input', {
          type: 'checkbox',
          checked: draft.includes(p.id),
          disabled: busy,
          onChange: () => toggleProvider(p.id),
        }),
        h('span', { className: 'mf_name', title: p.id }, p.name || p.id),
        h('span', { className: 'mf_count' }, p.models + ' 个模型'),
      ));

      const eventLines = events.slice().reverse().slice(0, 4).map((e) => {
        const t = new Date(e.time || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
        return t + '  ' + (e.from || '?') + ' [' + (e.code || '?') + '] → ' + (e.to || '(池尽)');
      }).join('\n');

      // 池内模型状态：🟢 今日可用 / 🔴 熔断冷却中 / ⚪ 未试
      const circuits = (status && status.circuits) || {};
      const success = (status && status.success) || {};
      const nowTs = (status && status.now) || Date.now();
      const pool = (status && status.pool) || [];
      const policy = (status && status.circuitPolicy) || {};
      const modelRows = pool.map((p) => {
        const key = p.provider + '/' + p.model;
        const c = circuits[key];
        const ok = success[key] && nowTs - success[key].at < 86400000;
        let badge = '⚪', stat = '';
        if (c && c.until > nowTs) {
          badge = '🔴';
          stat = '熔断 ' + Math.max(0, Math.round((c.until - nowTs) / 1000)) + 's';
        } else if (ok) {
          badge = '🟢';
          stat = '今日可用';
        }
        return h('div', { key, className: 'mf_mrow' },
          h('span', { className: 'mf_mbadge' }, badge),
          h('span', { className: 'mf_mname', title: key }, key),
          h('span', { className: 'mf_mstat' }, stat),
        );
      });
      const policyLine = policy.failureThreshold
        ? '熔断：' + policy.failureThreshold + ' 次/' + Math.round((policy.burstWindowMs || 0) / 1000) + 's → 冷却 ' + Math.round((policy.circuitCooldownMs || 0) / 1000) + 's'
        : '';

      const panel = h('div', { className: 'mf_root' },
        h('style', null, CSS),
        h('div', { className: 'mf_mask', onClick: () => setOpen(false) }),
        h('div', { className: 'mf_panel' },
          h('div', { className: 'mf_head' },
            h('span', { className: 'mf_title' }, '模型故障自动转移'),
            h('button', { type: 'button', className: 'mf_x', onClick: () => setOpen(false) }, '✕'),
          ),
          h('div', { className: 'mf_hint' },
            enabled ? ('✅ 已启用 · 池 ' + poolCount + ' 个候选') : '⛔ 已停用',
          ),
          h('div', { className: 'mf_hint' },
            '勾选供应商：池 = 所选供应商内的全部模型。请求失败（限流/配额/超时/5xx/传输）时自动切到池中下一个未试过的模型。',
          ),
          rows.length > 0 ? h('div', { className: 'mf_list' }, rows) : h('div', { className: 'mf_hint' }, '模型目录暂不可用（稍后重开面板重试）'),
          pool.length > 0 ? h('div', { className: 'mf_list' }, modelRows) : null,
          policyLine ? h('div', { className: 'mf_hint' }, policyLine) : null,
          h('div', { className: 'mf_actions' },
            h('button', {
              type: 'button',
              className: 'mf_act mf_primary',
              disabled: busy,
              onClick: () => run(() => api('set', { providers: draft })),
            }, busy ? '保存中…' : '保存'),
            h('button', {
              type: 'button',
              className: 'mf_act',
              disabled: busy,
              onClick: () => run(() => api('clear')),
            }, '清空'),
            h('button', {
              type: 'button',
              className: 'mf_act',
              disabled: busy,
              onClick: () => run(() => api('toggle', { enabled: !enabled })),
            }, enabled ? '停用' : '启用'),
          ),
          err ? h('div', { className: 'mf_err' }, err) : null,
          eventLines ? h('div', { className: 'mf_events' }, eventLines) : null,
        ),
      );
      return panel;
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, {
          zh: { title: '模型故障自动转移' },
          en: { title: 'Model failover' },
        }), 'dsh-model-failover: dictionaries');
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'model-failover',
          order: 50,
          locale: NS,
        }, FailoverSeat));
      },
    };
  },
});
