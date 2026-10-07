import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Bell,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  ExternalLink,
  Flag,
  Gauge,
  LayoutDashboard,
  ListChecks,
  Loader2,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import type { Task, TaskInput, Policy, Signal, QuotaWindow } from '../src/domain';
import type { Service } from '../src/service';
import './style.css';

type State = ReturnType<Service['snapshot']>;
type Tab = 'plan' | 'signals' | 'history' | 'settings';
type Modal =
  | { type: 'task'; task?: Task }
  | { type: 'quota' }
  | { type: 'signal' }
  | { type: 'checkpoint'; task: Task }
  | { type: 'notices' }
  | null;
async function api<T = unknown>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? '请求失败');
  return data;
}
const number = (n: number) => Number(n.toFixed(1));
const date = (value: string | null, full = false) =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        ...(full ? { year: 'numeric' } : {}),
      })
    : '未提供';
const inputDate = (iso: string | null) =>
  iso
    ? new Date(Date.parse(iso) - new Date(iso).getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)
    : '';
const fromInput = (value: string) => (value ? new Date(value).toISOString() : null);
function countdown(value: string | null) {
  if (!value) return '时间未知';
  const m = Math.max(0, Math.ceil((Date.parse(value) - Date.now()) / 60000));
  if (m === 0) return '等待重新同步';
  return m >= 1440
    ? `${Math.floor(m / 1440)} 天 ${Math.floor((m % 1440) / 60)} 小时`
    : `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`;
}
const priorities = { must: '必做', should: '优先', could: '可延期' };
const statuses = {
  queued: '排队中',
  running: '执行中',
  paused: '已暂停',
  review: '待验收',
  done: '已完成',
};
const kinds = {
  hint: '讨论信号',
  announced: '重置预告',
  confirmed: '重置记录',
  banked: '重置次数',
  incident: '故障记录',
};
const scopes = { all: '全体用户', paid: '付费用户', unknown: '范围未知', limited: '部分用户' };

function App() {
  const [state, setState] = useState<State | null>(null);
  const [tab, setTab] = useState<Tab>('plan');
  const [modal, setModal] = useState<Modal>(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [notifications, setNotifications] = useState(
    localStorage.getItem('quotacraft.notifications') === 'true',
  );
  const seen = useRef(new Set<string>());
  const initialized = useRef(false);
  const refresh = async () => {
    try {
      setState(await api<State>('/state'));
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法连接本地服务');
    }
  };
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!state) return;
    for (const n of state.notices) {
      if (
        initialized.current &&
        notifications &&
        !n.read &&
        !seen.current.has(n.id) &&
        'Notification' in window &&
        Notification.permission === 'granted'
      )
        new Notification(n.title, { body: n.body, tag: n.id });
      seen.current.add(n.id);
    }
    initialized.current = true;
  }, [state, notifications]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  const act = async (fn: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
      if (message) setToast(message);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
      return false;
    } finally {
      setBusy(false);
    }
  };
  const enableNotifications = async () => {
    if (!('Notification' in window)) {
      setError('当前浏览器不支持通知');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      setError('通知权限未开启；仍可在消息列表查看提醒');
      return;
    }
    setNotifications(true);
    localStorage.setItem('quotacraft.notifications', 'true');
    setToast('已开启浏览器提醒；保持页面打开以接收通知');
  };
  if (!state)
    return (
      <div className="loading">
        <Gauge size={44} />
        <h1>QuotaCraft</h1>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button onClick={() => void refresh()}>重新连接</button>
          </>
        ) : (
          <p>
            <Loader2 className="spin" size={16} /> 正在连接本地控制台
          </p>
        )}
      </div>
    );
  const active = state.tasks.filter((t) => t.status !== 'done');
  const notices = state.notices.filter((n) => !n.read).length;
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="QuotaCraft 首页">
          <span className="brand-symbol">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>
            QuotaCraft<small>每一份额度，都有安排</small>
          </span>
        </a>
        <div className="workspace-label">
          个人工作台 <span>LOCAL</span>
        </div>
        <nav aria-label="主导航">
          {(
            [
              { id: 'plan', label: '任务与预算', icon: LayoutDashboard },
              { id: 'signals', label: '重置信号', icon: Radio },
              { id: 'history', label: '策略成绩单', icon: ListChecks },
              { id: 'settings', label: '调度设置', icon: Settings2 },
            ] as const
          ).map((x) => (
            <button
              className={tab === x.id ? 'nav-item active' : 'nav-item'}
              key={x.id}
              onClick={() => setTab(x.id)}
            >
              <x.icon size={19} />
              {x.label}
              {x.id === 'plan' && <span className="nav-count">{active.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <ShieldCheck size={24} />
          <strong>在你的电脑上运行</strong>
          <p>任务与额度记录保存在本地。连接 Codex 即可读取真实额度。</p>
          <span className="online-dot" /> 本地服务已连接
        </div>
        <div className="sidebar-footer">
          v0.1.1 <span>OPEN SOURCE</span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span className="breadcrumb">
            工作台 <ChevronRight size={14} />
            {
              {
                plan: '任务与预算',
                signals: '重置信号',
                history: '策略成绩单',
                settings: '调度设置',
              }[tab]
            }
          </span>
          <div className="top-actions">
            <span className={`source-tag ${state.demo ? 'demo' : ''}`}>
              {state.demo
                ? '演示空间'
                : state.quota?.source === 'codex'
                  ? 'Codex 已连接'
                  : '手动规划'}
            </span>
            <button
              className="icon-button"
              aria-label={`查看消息，${notices} 条未读`}
              onClick={() => setModal({ type: 'notices' })}
            >
              <Bell size={20} />
              {notices > 0 && <i className="notification-dot" />}
            </button>
          </div>
        </header>
        <main id="main">
          {state.demo && (
            <div className="demo-banner">
              <Terminal size={16} />
              <span>
                当前为独立演示空间，额度和任务均为示例。真实连接请运行 <code>npm start</code>。
              </span>
            </div>
          )}
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button aria-label="关闭错误提示" onClick={() => setError('')}>
                <X size={16} />
              </button>
            </div>
          )}
          {tab === 'plan' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">WORK, WITH A BUDGET</div>
                  <h1>把额度，留给重要的事。</h1>
                  <p>先保障必须完成的任务，再安排值得推进的工作。</p>
                </div>
                <button className="primary" onClick={() => setModal({ type: 'task' })}>
                  <Plus size={18} /> 添加任务
                </button>
              </div>
              <div className="overview-grid">
                <section className="card budget-card">
                  <div className="section-top">
                    <h2>
                      <Gauge size={18} /> 本轮额度安排
                    </h2>
                    <button className="text-button" onClick={() => setModal({ type: 'quota' })}>
                      录入额度 <ArrowRight size={14} />
                    </button>
                  </div>
                  <div className="budget-values">
                    <div>
                      <span>可安排预算</span>
                      <strong>
                        {number(state.plan.availableBudget)}
                        <small> pp</small>
                      </strong>
                    </div>
                    <div className="budget-support">
                      <span>
                        最紧窗口剩余 <b>{number(state.plan.remaining)}%</b>
                      </span>
                      <span>
                        应急预留 <b>{state.policy.reservePercent}%</b>
                      </span>
                    </div>
                  </div>
                  <div className="allocation-rail" aria-label="剩余、已安排和预留额度">
                    <div
                      className="rail-used"
                      style={{ width: `${100 - state.plan.remaining}%` }}
                    />
                    <div
                      className="rail-planned"
                      style={{ width: `${Math.min(state.plan.allocated, state.plan.remaining)}%` }}
                    />
                    <div
                      className="rail-free"
                      style={{
                        width: `${Math.max(0, state.plan.remaining - state.plan.allocated - state.policy.reservePercent)}%`,
                      }}
                    />
                    <div
                      className="rail-reserve"
                      style={{
                        width: `${Math.min(state.policy.reservePercent, Math.max(0, state.plan.remaining - state.plan.allocated))}%`,
                      }}
                    />
                  </div>
                  <div className="rail-legend">
                    <span>
                      <i className="planned" />
                      已安排 {number(state.plan.allocated)} pp
                    </span>
                    <span>
                      <i className="free" />
                      未分配 {number(state.plan.unallocatedBudget)} pp
                    </span>
                    <span>
                      <i className="reserve" />
                      预留
                    </span>
                  </div>
                  <p className="footnote">
                    pp = 额度百分点。估计成本保守应用到每个窗口，并计入收尾预算。
                  </p>
                </section>
                <section className="card reset-card">
                  <div className="section-top">
                    <h2>
                      <Clock3 size={18} /> 下次周期恢复
                    </h2>
                    <span className={`badge ${state.plan.fresh ? 'green' : 'amber'}`}>
                      {state.plan.fresh ? '数据有效' : '需要同步'}
                    </span>
                  </div>
                  <strong className="reset-countdown">{countdown(state.plan.nextResetAt)}</strong>
                  <p>{date(state.plan.nextResetAt)}</p>
                  <div className="reset-bottom">
                    <span>
                      {state.quota ? `上次读取 ${date(state.quota.observedAt)}` : '尚无额度数据'}
                    </span>
                    <button
                      className="text-button"
                      disabled={busy || state.demo}
                      onClick={() => void act(() => api('/quota/refresh', {}), '额度已同步')}
                    >
                      <RefreshCw size={14} className={busy ? 'spin' : ''} /> 同步 Codex
                    </button>
                  </div>
                </section>
              </div>
              <div className="window-row">
                {state.quota?.windows.map((w) => (
                  <div className="window-meter" key={w.id}>
                    <div>
                      <span>{w.name}</span>
                      <b>{number(100 - w.usedPercent)}% 剩余</b>
                    </div>
                    <div className="thin-track">
                      <i style={{ width: `${100 - w.usedPercent}%` }} />
                    </div>
                    <small>{countdown(w.resetsAt)}后恢复</small>
                  </div>
                )) ?? <p className="empty-inline">录入额度，或连接 Codex 开始规划。</p>}
              </div>
              <section className="card queue-card">
                <div className="section-top queue-heading">
                  <div>
                    <h2>
                      任务安排 <span className="count">{active.length}</span>
                    </h2>
                    <p>每一项安排，都有可检查的预算和理由。</p>
                  </div>
                  <span className="badge blue">{state.plan.readyCount} 项可开始</span>
                </div>
                <div className="task-table-head">
                  <span>任务 / 项目</span>
                  <span>截止时间</span>
                  <span>执行预算</span>
                  <span>安排</span>
                </div>
                {!active.length && (
                  <div className="empty-state">
                    <Flag size={32} />
                    <h3>先放进一件重要的事</h3>
                    <p>填写截止时间和成本估计，系统会为它安排预算。</p>
                    <button onClick={() => setModal({ type: 'task' })}>
                      <Plus size={16} /> 添加第一个任务
                    </button>
                  </div>
                )}
                {state.plan.decisions
                  .filter((d) => d.action !== 'done')
                  .map((d) => {
                    const task = state.tasks.find((t) => t.id === d.taskId)!;
                    return (
                      <article className="task-row" key={task.id}>
                        <div className="task-identity">
                          <div className={`task-mark ${task.priority}`}>
                            <Flag size={17} />
                          </div>
                          <div>
                            <button
                              className="task-title"
                              onClick={() => setModal({ type: 'task', task })}
                            >
                              {task.title}
                            </button>
                            <div className="task-meta">
                              <span>{task.project}</span>
                              <span className={`priority ${task.priority}`}>
                                {priorities[task.priority]}
                              </span>
                              <span>{statuses[task.status]}</span>
                            </div>
                            <p className="task-reason">{d.reason}</p>
                          </div>
                        </div>
                        <div className="task-deadline">
                          {task.deadline ? date(task.deadline) : '可灵活安排'}
                          {d.deadlineRisk && <span className="risk-label">截止时间有风险</span>}
                        </div>
                        <div className="task-cost">
                          <b>
                            {number(task.estimateHigh + task.finishReserve)} <small>pp</small>
                          </b>
                          <span>含收尾 {task.finishReserve} pp</span>
                          <span>
                            {task.minutes} 分钟 ·{' '}
                            {task.quality === 'high'
                              ? '高质量'
                              : task.quality === 'economy'
                                ? '轻量'
                                : '均衡'}
                          </span>
                        </div>
                        <div className="task-actions">
                          <span
                            className={`badge ${d.action === 'ready' ? 'green' : d.action === 'finish' ? 'blue' : d.action === 'review' ? 'purple' : 'neutral'}`}
                          >
                            {
                              {
                                ready: '可开始',
                                wait: '暂缓',
                                finish: '优先收尾',
                                review: '待验收',
                                done: '完成',
                              }[d.action]
                            }
                          </span>
                          <div className="task-button-group">
                            {task.status === 'paused' ? (
                              <button
                                className="small-button"
                                disabled={busy}
                                onClick={() =>
                                  void act(() => api(`/tasks/${task.id}/resume`, {}), '已恢复排队')
                                }
                              >
                                <Play size={13} /> 恢复
                              </button>
                            ) : task.status === 'running' ? (
                              <button
                                className="small-button"
                                disabled={busy}
                                onClick={() =>
                                  void act(() => api(`/tasks/${task.id}/pause`, {}), '已请求暂停')
                                }
                              >
                                <Pause size={13} /> 暂停
                              </button>
                            ) : task.status === 'review' ? (
                              <button
                                className="small-button"
                                disabled={busy}
                                onClick={() =>
                                  void act(
                                    () => api(`/tasks/${task.id}/review`, { accepted: true }),
                                    '已记录验收通过',
                                  )
                                }
                              >
                                <Check size={13} /> 验收通过
                              </button>
                            ) : (
                              <button
                                className="small-button"
                                disabled={busy || d.action !== 'ready' || !state.executionEnabled}
                                title={
                                  !state.executionEnabled
                                    ? '启动时设置 QUOTACRAFT_ALLOW_EXEC=1 后可执行'
                                    : ''
                                }
                                onClick={() =>
                                  void act(() => api(`/tasks/${task.id}/start`, {}), '任务已启动')
                                }
                              >
                                <Play size={13} /> 执行
                              </button>
                            )}
                            <button
                              className="icon-button compact"
                              aria-label={`保存 ${task.title} 的断点`}
                              onClick={() => setModal({ type: 'checkpoint', task })}
                            >
                              <Save size={15} />
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                <div className="queue-footer">
                  <ShieldCheck size={16} /> 任务串行执行；更换档位在任务边界生效，验收要求由你决定。
                </div>
              </section>
              <div className="bottom-grid">
                <section className="card pace-card">
                  <div className="section-top">
                    <h2>
                      <Activity size={18} /> 消耗速度
                    </h2>
                  </div>
                  {state.burn.length ? (
                    state.burn.map((b) => (
                      <div className="pace-row" key={b.id}>
                        <span>{b.name}</span>
                        <b>{b.perHour === null ? '样本不足' : `${number(b.perHour)} pp / 小时`}</b>
                        <small>
                          {b.minutesToEmpty !== null
                            ? `照此速度约 ${Math.floor(b.minutesToEmpty / 60)} 小时耗尽`
                            : '至少需要 3 次连续读数，覆盖 10 分钟'}
                        </small>
                      </div>
                    ))
                  ) : (
                    <p className="muted">读取额度后开始记录趋势。</p>
                  )}
                </section>
                <section className="card signal-preview">
                  <div className="section-top">
                    <h2>
                      <Radio size={18} /> 临时重置信号
                    </h2>
                    <button className="text-button" onClick={() => setTab('signals')}>
                      查看信号 <ArrowRight size={14} />
                    </button>
                  </div>
                  <p className="signal-title">
                    {state.forecast.announcedAt
                      ? `已预告 ${date(state.forecast.announcedAt)}`
                      : '暂无可执行的重置预告'}
                  </p>
                  <p className="muted">
                    实验预测与明确公告分别展示。预测不会自动改变必做任务预算。
                  </p>
                  <span className="badge neutral">{state.forecast.sampleCount} 个有效历史间隔</span>
                </section>
              </div>
            </>
          )}
          {tab === 'signals' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">EVIDENCE BEFORE EXPECTATIONS</div>
                  <h1>重置信号，逐条有据。</h1>
                  <p>区分预告、已发生的重置和赠送次数。提醒后再观察本账号是否恢复。</p>
                </div>
                <button className="primary" onClick={() => setModal({ type: 'signal' })}>
                  <Plus size={18} /> 添加信号
                </button>
              </div>
              <div className="forecast-grid">
                {[
                  { label: '未来 24 小时', value: state.forecast.probability24h },
                  { label: '未来 72 小时', value: state.forecast.probability72h },
                  { label: '未来 7 天', value: state.forecast.probability7d },
                ].map((f) => (
                  <section className="card forecast-card" key={f.label}>
                    <span>{f.label}</span>
                    <strong>{f.value === null ? '—' : `${Math.round(f.value * 100)}%`}</strong>
                    <small>
                      {f.value === null ? '历史样本不足，暂不估计' : '实验性估计，尚未校准'}
                    </small>
                  </section>
                ))}
              </div>
              <section className="card source-card">
                <div>
                  <h2>连接公开信号</h2>
                  <p>本地模型使用明确标为全体用户的重置记录。社区预测独立显示，不参与执行决策。</p>
                </div>
                <div className="button-group">
                  <button
                    disabled={busy || state.demo}
                    onClick={() =>
                      void act(
                        () => api('/signals/sync', { source: 'community' }),
                        '社区预测已更新',
                      )
                    }
                  >
                    <RefreshCw size={16} /> 社区预测
                  </button>
                  <button
                    disabled={busy || state.demo}
                    onClick={() =>
                      void act(() => api('/signals/sync', { source: 'x' }), 'Tibo 动态已同步')
                    }
                  >
                    <Radio size={16} /> 同步 Tibo
                  </button>
                </div>
                {state.externalForecast && (
                  <div className="external-forecast">
                    <strong>
                      社区预测：24h {Math.round(state.externalForecast.probability24h * 100)}% / 72h{' '}
                      {Math.round(state.externalForecast.probability72h * 100)}%
                    </strong>
                    <span>更新于 {date(state.externalForecast.checkedAt)} · 第三方估计</span>
                    <a href={state.externalForecast.sourceUrl} target="_blank" rel="noreferrer">
                      查看来源 <ExternalLink size={13} />
                    </a>
                  </div>
                )}
              </section>
              <section className="card">
                <div className="section-top">
                  <h2>信号记录</h2>
                  <span className="muted">{state.signals.length} 条</span>
                </div>
                {!state.signals.length ? (
                  <div className="empty-state">
                    <Radio size={32} />
                    <h3>为每一条信号保留来源</h3>
                    <p>添加原帖链接，或同步已配置的 X API。</p>
                  </div>
                ) : (
                  state.signals.map((s) => (
                    <article className="signal-row" key={s.id}>
                      <span className={`signal-dot ${s.kind}`} />
                      <div>
                        <div className="signal-row-top">
                          <span
                            className={`badge ${s.kind === 'announced' ? 'blue' : s.kind === 'confirmed' ? 'green' : 'neutral'}`}
                          >
                            {kinds[s.kind]}
                          </span>
                          <span>
                            {scopes[s.scope]} ·{' '}
                            {s.origin === 'demo' ? '演示' : s.origin === 'x' ? 'X API' : '手动录入'}
                          </span>
                          <time>{date(s.occurredAt)}</time>
                        </div>
                        <h3>{s.title}</h3>
                        {s.resetAt && <p>预告时间：{date(s.resetAt, true)}</p>}
                        <p className="muted">{s.evidence}</p>
                        <a href={s.sourceUrl} target="_blank" rel="noreferrer">
                          查看原始来源 <ExternalLink size={13} />
                        </a>
                      </div>
                    </article>
                  ))
                )}
              </section>
              <p className="method-note">
                本地模型：历史间隔的条件经验分布，加 Beta(2,2) 平滑。至少 10 个有效间隔和 5
                个当前条件样本后显示估计；演示、范围不明和局部重置不计入训练。尚无校准保证。
              </p>
            </>
          )}
          {tab === 'history' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">MEASURE WHAT GOT DONE</div>
                  <h1>让安排，经得起复盘。</h1>
                  <p>记录实际验收、截止时间和预算误差，逐步改善下一次安排。</p>
                </div>
                <button onClick={() => void download()}>
                  <ArrowDownToLine size={17} /> 导出本地记录
                </button>
              </div>
              <div className="stats-grid">
                <Stat
                  label="已验收任务"
                  value={String(state.stats.completed)}
                  note="由你确认通过"
                />
                <Stat
                  label="按时完成"
                  value={String(state.stats.onTime)}
                  note="按任务截止时间计算"
                />
                <Stat label="待恢复任务" value={String(state.stats.paused)} note="断点保留在本地" />
                <Stat
                  label="平均估计误差"
                  value={
                    state.stats.averageEstimateError === null
                      ? '—'
                      : `${number(state.stats.averageEstimateError)} pp`
                  }
                  note={`${state.stats.costSamples} 个有效成本样本`}
                />
              </div>
              <section className="card">
                <div className="section-top">
                  <h2>已验收任务</h2>
                </div>
                {state.tasks.filter((t) => t.status === 'done').length ? (
                  state.tasks
                    .filter((t) => t.status === 'done')
                    .map((t) => (
                      <div className="completed-row" key={t.id}>
                        <CheckCircle2 size={20} />
                        <div>
                          <strong>{t.title}</strong>
                          <span>
                            {t.project} · {date(t.completedAt)}
                          </span>
                        </div>
                        <span>
                          {t.actualCost === null
                            ? '成本未记录'
                            : `${number(t.actualCost)} pp 账号变化`}
                        </span>
                      </div>
                    ))
                ) : (
                  <div className="empty-state">
                    <CheckCircle2 size={32} />
                    <h3>成绩从完成第一件事开始</h3>
                    <p>执行或保存断点后，确认验收结果就会在这里留下记录。</p>
                  </div>
                )}
              </section>
              <section className="card audit-card">
                <div className="section-top">
                  <h2>调度记录</h2>
                </div>
                {state.audit.map((a, i) => (
                  <div className="audit-row" key={i}>
                    <time>{date(a.at)}</time>
                    <span>
                      {{
                        task_created: '任务已创建',
                        policy_changed: '调度策略已更新',
                        checkpoint_saved: '断点已保存',
                        task_reviewed: '验收结果已记录',
                        run_started: '任务已启动',
                        run_finished: '任务执行结束',
                        run_pause_requested: '已请求暂停',
                      }[a.event as string] ?? a.event}
                    </span>
                  </div>
                ))}
              </section>
              <p className="method-note">
                执行期间观测到的额度变化可能包含其他设备或任务消耗，属于账号变化，不能视为精确的单任务计费。导出包含任务说明和断点，请保存在私人位置。
              </p>
            </>
          )}
          {tab === 'settings' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">YOUR PRIORITIES, YOUR RULES</div>
                  <h1>额度怎么用，由你决定。</h1>
                  <p>保留应急余量，选择任务档位，在明确边界内自动推进。</p>
                </div>
              </div>
              <SettingsForm
                state={state}
                busy={busy}
                save={async (p) => {
                  await act(() => api('/policy', p, 'PUT'), '调度设置已保存');
                }}
              />
              <section className="card settings-card">
                <h2>通知与数据</h2>
                <div className="setting-row">
                  <div>
                    <strong>浏览器提醒</strong>
                    <p>页面打开时接收额度恢复、重置公告和任务结束提醒。</p>
                  </div>
                  <button
                    onClick={() =>
                      notifications
                        ? (setNotifications(false),
                          localStorage.removeItem('quotacraft.notifications'))
                        : void enableNotifications()
                    }
                  >
                    {notifications ? '关闭提醒' : '开启提醒'}
                  </button>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>导出记录</strong>
                    <p>导出任务、信号和调度记录。数据始终保存在这台电脑上。</p>
                  </div>
                  <button onClick={() => void download()}>
                    <ArrowDownToLine size={16} /> 导出 JSON
                  </button>
                </div>
              </section>
              <section className="card settings-card">
                <h2>连接 Codex / MCP</h2>
                <p className="muted">
                  使用已登录的 Codex CLI 读取额度。自动执行需设置环境变量后重新启动：
                </p>
                <pre>QUOTACRAFT_ALLOW_EXEC=1 npm start</pre>
                <p className="muted">
                  Windows PowerShell：<code>$env:QUOTACRAFT_ALLOW_EXEC='1'; npm start</code>
                </p>
                <p className="muted">
                  MCP 启动命令：<code>node /绝对路径/quotacraft/dist/cli.js mcp</code>。完整配置见
                  README。
                </p>
              </section>
            </>
          )}
          <footer className="main-footer">
            <span>QuotaCraft · 本地优先的额度调度</span>
            <span>时间按设备时区显示 · {Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={17} />
          {toast}
        </div>
      )}
      {modal && (
        <Dialog
          title={
            modal.type === 'task'
              ? modal.task
                ? '编辑任务'
                : '添加任务'
              : modal.type === 'quota'
                ? '录入额度'
                : modal.type === 'signal'
                  ? '添加重置信号'
                  : modal.type === 'checkpoint'
                    ? '保存断点'
                    : '消息与提醒'
          }
          close={() => setModal(null)}
        >
          {modal.type === 'task' && (
            <TaskForm
              task={modal.task}
              busy={busy}
              save={async (input) => {
                const ok = await act(
                  () =>
                    api(
                      modal.task ? `/tasks/${modal.task.id}` : '/tasks',
                      input,
                      modal.task ? 'PATCH' : 'POST',
                    ),
                  '任务已保存',
                );
                if (ok) setModal(null);
              }}
              remove={
                modal.task
                  ? async () => {
                      const ok = await act(
                        () => api(`/tasks/${modal.task!.id}`, undefined, 'DELETE'),
                        '任务已删除',
                      );
                      if (ok) setModal(null);
                    }
                  : undefined
              }
            />
          )}
          {modal.type === 'quota' && (
            <QuotaForm
              windows={state.quota?.windows ?? []}
              busy={busy}
              save={async (windows) => {
                if (await act(() => api('/quota/manual', { windows }), '额度已录入'))
                  setModal(null);
              }}
            />
          )}
          {modal.type === 'signal' && (
            <SignalForm
              busy={busy}
              save={async (signal) => {
                if (await act(() => api('/signals', signal), '信号已保存')) setModal(null);
              }}
            />
          )}
          {modal.type === 'checkpoint' && (
            <CheckpointForm
              task={modal.task}
              busy={busy}
              save={async (text, accepted, actualCost) => {
                if (
                  await act(
                    async () => {
                      await api(`/tasks/${modal.task.id}/checkpoint`, { text });
                      if (accepted)
                        await api(`/tasks/${modal.task.id}/review`, { accepted: true, actualCost });
                    },
                    accepted ? '已记录验收通过' : '断点已保存',
                  )
                )
                  setModal(null);
              }}
            />
          )}
          {modal.type === 'notices' && (
            <div className="notice-list">
              <button
                className="text-button"
                onClick={() => void act(() => api('/notices/read', {}), '消息已标为已读')}
              >
                全部标为已读
              </button>
              {state.notices.length ? (
                state.notices.map((n) => (
                  <article key={n.id} className={n.read ? 'read' : ''}>
                    <Bell size={17} />
                    <div>
                      <strong>{n.title}</strong>
                      <p>{n.body}</p>
                      <time>{date(n.createdAt)}</time>
                    </div>
                  </article>
                ))
              ) : (
                <div className="empty-state">
                  <Bell size={32} />
                  <p>有新的额度或任务进展时，会在这里提醒你。</p>
                </div>
              )}
            </div>
          )}
        </Dialog>
      )}
    </div>
  );
  async function download() {
    try {
      const data = await api('/export');
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `quotacraft-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出失败');
    }
  }
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <section className="card stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </section>
  );
}
function Dialog({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    const previous = document.activeElement;
    d.showModal();
    (
      d.querySelector<HTMLElement>('input, textarea, select') ??
      d.querySelector<HTMLElement>('button')
    )?.focus();
    return () => {
      d.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === ref.current) close();
      }}
    >
      <div className="dialog-inner">
        <div className="dialog-head">
          <h2>{title}</h2>
          <button aria-label="关闭弹窗" className="icon-button" onClick={close}>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
function TaskForm({
  task,
  busy,
  save,
  remove,
}: {
  task?: Task;
  busy: boolean;
  save: (t: TaskInput) => Promise<void>;
  remove?: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    title: task?.title ?? '',
    project: task?.project ?? '',
    prompt: task?.prompt ?? '',
    workspace: task?.workspace ?? '',
    priority: task?.priority ?? 'should',
    deadline: inputDate(task?.deadline ?? null),
    estimateLow: task?.estimateLow ?? 3,
    estimateHigh: task?.estimateHigh ?? 6,
    finishReserve: task?.finishReserve ?? 2,
    minutes: task?.minutes ?? 30,
    quality: task?.quality ?? 'balanced',
    acceptance: task?.acceptance ?? '',
  });
  const change = (key: string, value: unknown) => setForm((f) => ({ ...f, [key]: value }));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save({ ...form, deadline: fromInput(form.deadline) });
      }}
    >
      <label>
        任务名称
        <input
          required
          maxLength={160}
          value={form.title}
          onChange={(e) => change('title', e.target.value)}
          placeholder="例如：修复登录回调异常"
          autoFocus
        />
      </label>
      <div className="form-grid">
        <label>
          项目
          <input
            required
            value={form.project}
            onChange={(e) => change('project', e.target.value)}
            placeholder="atlas-web"
          />
        </label>
        <label>
          重要性
          <select value={form.priority} onChange={(e) => change('priority', e.target.value)}>
            <option value="must">必做</option>
            <option value="should">优先</option>
            <option value="could">可延期</option>
          </select>
        </label>
      </div>
      <div className="form-grid">
        <label>
          截止时间（可选）
          <input
            type="datetime-local"
            value={form.deadline}
            onChange={(e) => change('deadline', e.target.value)}
          />
        </label>
        <label>
          预计用时（分钟）
          <input
            required
            type="number"
            min={1}
            max={1440}
            value={form.minutes}
            onChange={(e) => change('minutes', Number(e.target.value))}
          />
        </label>
      </div>
      <div className="form-grid three">
        <label>
          最低估计（pp）
          <input
            required
            type="number"
            min={0.1}
            max={100}
            step={0.1}
            value={form.estimateLow}
            onChange={(e) => change('estimateLow', Number(e.target.value))}
          />
        </label>
        <label>
          最高估计（pp）
          <input
            required
            type="number"
            min={form.estimateLow}
            max={100}
            step={0.1}
            value={form.estimateHigh}
            onChange={(e) => change('estimateHigh', Number(e.target.value))}
          />
        </label>
        <label>
          收尾预留（pp）
          <input
            required
            type="number"
            min={0}
            max={50}
            step={0.1}
            value={form.finishReserve}
            onChange={(e) => change('finishReserve', Number(e.target.value))}
          />
        </label>
      </div>
      <label>
        质量要求
        <select value={form.quality} onChange={(e) => change('quality', e.target.value)}>
          <option value="high">高质量 · 复杂修复、设计和验证</option>
          <option value="balanced">均衡 · 常规开发</option>
          <option value="economy">轻量 · 文档和整理</option>
        </select>
      </label>
      <label>
        验收要求
        <textarea
          value={form.acceptance}
          onChange={(e) => change('acceptance', e.target.value)}
          rows={2}
          placeholder="哪些检查通过才算完成？"
        />
      </label>
      <details className="execution-details" open={Boolean(form.prompt || form.workspace)}>
        <summary>
          执行配置 <span>开启自动执行前填写</span>
        </summary>
        <label>
          绝对工作目录
          <input
            value={form.workspace}
            onChange={(e) => change('workspace', e.target.value)}
            placeholder="F:\Workspace\my-project"
          />
        </label>
        <label>
          给 Codex 的执行说明
          <textarea
            value={form.prompt}
            onChange={(e) => change('prompt', e.target.value)}
            rows={4}
            placeholder="描述问题、允许修改的范围和预期行为"
          />
        </label>
      </details>
      <div className="form-footer">
        {remove && (
          <button
            type="button"
            className="danger"
            disabled={busy || task?.status === 'running'}
            onClick={() => void remove()}
          >
            <Trash2 size={15} /> 删除任务
          </button>
        )}
        <button className="primary" disabled={busy || task?.status === 'running'} type="submit">
          <Save size={16} /> 保存任务
        </button>
      </div>
    </form>
  );
}
function QuotaForm({
  windows,
  busy,
  save,
}: {
  windows: QuotaWindow[];
  busy: boolean;
  save: (w: QuotaWindow[]) => Promise<void>;
}) {
  const now = Date.now();
  const base = windows.length
    ? windows
    : [
        {
          id: 'manual:weekly',
          name: '每周窗口',
          usedPercent: 0,
          windowMinutes: 10080,
          resetsAt: new Date(now + 7 * 86400000).toISOString(),
        },
      ];
  const [values, setValues] = useState(base.map((w) => ({ ...w, reset: inputDate(w.resetsAt) })));
  const change = (i: number, key: string, value: unknown) =>
    setValues((v) => v.map((w, j) => (j === i ? { ...w, [key]: value } : w)));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save(values.map(({ reset, ...w }) => ({ ...w, resetsAt: fromInput(reset) })));
      }}
    >
      <p className="form-help">
        从官方用量界面填写。手动数据用于规划；实际执行需要同步真实 Codex 额度。
      </p>
      {values.map((w, i) => (
        <fieldset key={w.id}>
          <legend>{w.name}</legend>
          <div className="form-grid">
            <label>
              已使用（%）
              <input
                required
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={w.usedPercent}
                onChange={(e) => change(i, 'usedPercent', Number(e.target.value))}
              />
            </label>
            <label>
              重置时间
              <input
                type="datetime-local"
                value={w.reset}
                onChange={(e) => change(i, 'reset', e.target.value)}
              />
            </label>
          </div>
        </fieldset>
      ))}
      <button
        type="button"
        className="text-button"
        disabled={values.length >= 2}
        onClick={() =>
          setValues((v) => [
            ...v,
            {
              id: 'manual:short',
              name: '短期窗口',
              usedPercent: 0,
              windowMinutes: 300,
              resetsAt: null,
              reset: inputDate(new Date(now + 5 * 3600000).toISOString()),
            },
          ])
        }
      >
        <Plus size={15} /> 添加短期窗口
      </button>
      <div className="form-footer">
        <button className="primary" type="submit" disabled={busy}>
          保存额度
        </button>
      </div>
    </form>
  );
}
function SignalForm({ busy, save }: { busy: boolean; save: (s: unknown) => Promise<void> }) {
  const [kind, setKind] = useState<Signal['kind']>('hint');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const d = new FormData(e.currentTarget);
        void save({
          id: crypto.randomUUID(),
          title: d.get('title'),
          kind,
          occurredAt: fromInput(String(d.get('occurredAt'))),
          resetAt: fromInput(String(d.get('resetAt') ?? '')),
          scope: d.get('scope'),
          sourceUrl: d.get('sourceUrl'),
          evidence: d.get('evidence'),
        });
      }}
    >
      <label>
        信号摘要
        <input
          name="title"
          required
          maxLength={300}
          placeholder="请准确概括，不把讨论当成承诺"
          autoFocus
        />
      </label>
      <div className="form-grid">
        <label>
          类型
          <select value={kind} onChange={(e) => setKind(e.target.value as Signal['kind'])}>
            {Object.entries(kinds).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          适用范围
          <select name="scope">
            {Object.entries(scopes).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        原帖链接
        <input
          name="sourceUrl"
          type="url"
          required
          placeholder="https://x.com/thsottiaux/status/..."
        />
      </label>
      <div className="form-grid">
        <label>
          发布 / 发生时间
          <input
            name="occurredAt"
            type="datetime-local"
            required
            defaultValue={inputDate(new Date().toISOString())}
          />
        </label>
        <label>
          预告重置时间
          <input name="resetAt" type="datetime-local" required={kind === 'announced'} />
        </label>
      </div>
      <label>
        证据与范围说明
        <textarea
          name="evidence"
          rows={4}
          maxLength={3000}
          placeholder="保留可核对的原文和范围信息"
        />
      </label>
      <p className="form-help">手动记录会标为手动来源。已发生的重置与赠送次数分别统计。</p>
      <div className="form-footer">
        <button className="primary" disabled={busy}>
          保存信号
        </button>
      </div>
    </form>
  );
}
function CheckpointForm({
  task,
  busy,
  save,
}: {
  task: Task;
  busy: boolean;
  save: (s: string, accepted: boolean, actualCost?: number) => Promise<void>;
}) {
  const [text, setText] = useState(task.checkpoint);
  const [accepted, setAccepted] = useState(false);
  const [cost, setCost] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save(text, accepted, cost === '' ? undefined : Number(cost));
      }}
    >
      <p className="form-help">
        记录已改文件、已运行检查、未完成工作和安全的下一步。保存后任务暂停。
      </p>
      <label>
        断点说明
        <textarea
          required
          autoFocus
          rows={8}
          maxLength={12000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="已完成：\n验证结果：\n剩余工作：\n下一步："
        />
      </label>
      <label className="acceptance-option">
        <input
          type="checkbox"
          checked={accepted}
          disabled={task.status === 'running'}
          onChange={(e) => setAccepted(e.target.checked)}
        />
        确认已满足验收要求（执行中请先暂停）
      </label>
      {accepted && (
        <label>
          观测到的额度成本（pp，可选）
          <input
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
        </label>
      )}
      <div className="form-footer">
        <button className="primary" disabled={busy}>
          <Save size={16} /> {accepted ? '保存并验收' : '保存并暂停'}
        </button>
      </div>
    </form>
  );
}
function SettingsForm({
  state,
  busy,
  save,
}: {
  state: State;
  busy: boolean;
  save: (p: Policy) => Promise<void>;
}) {
  const [form, setForm] = useState(state.policy);
  const change = (key: string, value: unknown) => setForm((f) => ({ ...f, [key]: value }));
  return (
    <form
      className="card settings-card"
      onSubmit={(e) => {
        e.preventDefault();
        void save(form);
      }}
    >
      <h2>预算与执行边界</h2>
      <div className="setting-row">
        <div>
          <strong>应急预留</strong>
          <p>每个已暴露窗口都保留这部分额度。</p>
        </div>
        <label className="inline-number">
          <input
            aria-label="应急预留百分比"
            type="number"
            min={0}
            max={80}
            required
            value={form.reservePercent}
            onChange={(e) => change('reservePercent', Number(e.target.value))}
          />
          %
        </label>
      </div>
      <div className="setting-row">
        <div>
          <strong>自动推进任务队列</strong>
          <p>
            {state.executionEnabled
              ? '仅执行你创建的任务，串行运行，结束后等待验收。'
              : '需先设置 QUOTACRAFT_ALLOW_EXEC=1 并重启正常模式。'}
          </p>
        </div>
        <input
          type="checkbox"
          aria-label="自动推进任务队列"
          disabled={!state.executionEnabled}
          checked={form.autoRun}
          onChange={(e) => change('autoRun', e.target.checked)}
        />
      </div>
      <div className="setting-row">
        <div>
          <strong>临时重置机会预算</strong>
          <p>仅在明确全体重置预告后，允许可延期任务使用少量预留额度。</p>
        </div>
        <input
          type="checkbox"
          aria-label="临时重置机会预算"
          checked={form.opportunistic}
          onChange={(e) => change('opportunistic', e.target.checked)}
        />
      </div>
      {form.opportunistic && (
        <label>
          最多释放的机会预算（pp）
          <input
            type="number"
            min={0}
            max={20}
            value={form.opportunityPercent}
            onChange={(e) => change('opportunityPercent', Number(e.target.value))}
          />
        </label>
      )}
      <div className="form-grid">
        <label>
          数据有效期（分钟）
          <input
            required
            type="number"
            min={1}
            max={60}
            value={form.staleMinutes}
            onChange={(e) => change('staleMinutes', Number(e.target.value))}
          />
        </label>
      </div>
      <h2 className="settings-subheading">任务模型档位</h2>
      <p className="form-help">
        填写账号可用的模型 ID。高质量任务保留高推理档位；不因额度低而偷偷降档。
      </p>
      <div className="form-grid three">
        <label>
          高质量
          <input
            required
            value={form.modelHigh}
            onChange={(e) => change('modelHigh', e.target.value)}
          />
        </label>
        <label>
          均衡
          <input
            required
            value={form.modelBalanced}
            onChange={(e) => change('modelBalanced', e.target.value)}
          />
        </label>
        <label>
          轻量
          <input
            required
            value={form.modelEconomy}
            onChange={(e) => change('modelEconomy', e.target.value)}
          />
        </label>
      </div>
      <div className="form-footer">
        <button type="submit" className="primary" disabled={busy}>
          <Save size={16} /> 保存设置
        </button>
      </div>
    </form>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
