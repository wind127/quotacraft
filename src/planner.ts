import type { Decision, Policy, QuotaSnapshot, Signal, Task } from './domain.js';

export function isFresh(q: QuotaSnapshot | null, policy: Policy, now: number) {
  if (!q || !q.windows.length) return false;
  const age = now - Date.parse(q.observedAt);
  return (
    age >= -60_000 &&
    age <= policy.staleMinutes * 60_000 &&
    q.windows.every((w) => w.resetsAt === null || Date.parse(w.resetsAt) > now)
  );
}

export function forecast(signals: Signal[], now: number) {
  // One event per 12h cluster: multiple posts about the same rollout are not extra resets.
  const events = signals
    .filter(
      (s) =>
        s.kind === 'confirmed' &&
        s.scope === 'all' &&
        s.origin !== 'demo' &&
        Date.parse(s.occurredAt) <= now &&
        Date.parse(s.knownAt) <= now,
    )
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const dates: number[] = [];
  for (const s of events) {
    const t = Date.parse(s.occurredAt);
    if (!dates.length || t - dates.at(-1)! > 12 * 3600_000) dates.push(t);
  }
  const announcement = signals
    .filter(
      (s) =>
        s.kind === 'announced' &&
        s.origin !== 'demo' &&
        s.resetAt &&
        Date.parse(s.resetAt) > now &&
        now - Date.parse(s.knownAt) < 7 * 86400_000,
    )
    .sort((a, b) => Date.parse(b.knownAt) - Date.parse(a.knownAt))[0];
  const gaps = dates.slice(1).map((t, i) => (t - dates[i]) / 86400_000);
  const age = dates.length ? (now - dates.at(-1)!) / 86400_000 : 0;
  const exposed = gaps.filter((g) => g > age);
  const enough = gaps.length >= 10 && exposed.length >= 5;
  const probability = (days: number) =>
    enough ? (exposed.filter((g) => g <= age + days).length + 2) / (exposed.length + 4) : null;
  return {
    status: announcement ? 'announced' : enough ? 'experimental' : 'insufficient_history',
    probability24h: probability(1),
    probability72h: probability(3),
    probability7d: probability(7),
    sampleCount: gaps.length,
    conditionalSamples: exposed.length,
    lastResetAt: dates.length ? new Date(dates.at(-1)!).toISOString() : null,
    announcedAt: announcement?.resetAt ?? null,
    sourceUrl: announcement?.sourceUrl ?? null,
    method:
      'Conditional empirical survival with Beta(2,2) smoothing. Not calibrated; announcements remain separate from predictions.',
  };
}

export function makePlan(
  tasks: Task[],
  q: QuotaSnapshot | null,
  policy: Policy,
  signals: Signal[],
  now = Date.now(),
) {
  const fresh = isFresh(q, policy, now);
  const remaining = q?.windows.length ? Math.min(...q.windows.map((w) => 100 - w.usedPercent)) : 0;
  let budget = Math.max(0, remaining - policy.reservePercent);
  const initialBudget = budget;
  const upcoming = signals.some(
    (s) =>
      s.kind === 'announced' &&
      s.origin !== 'demo' &&
      s.scope === 'all' &&
      s.resetAt &&
      Date.parse(s.resetAt) > now &&
      Date.parse(s.resetAt) - now < 24 * 3600_000 &&
      now - Date.parse(s.knownAt) < 7 * 86400_000,
  );
  // Speculative forecasts never expand the budget. Announcements can only release an explicitly opted-in slice.
  const opportunity =
    policy.opportunistic && upcoming
      ? Math.min(policy.opportunityPercent, policy.reservePercent)
      : 0;
  let opportunityBudget = opportunity;
  let cursor = now;
  const rank = { must: 0, should: 1, could: 2 };
  const ordered = [...tasks].sort((a, b) => {
    if (a.status === 'running' || b.status === 'running')
      return Number(b.status === 'running') - Number(a.status === 'running');
    return (
      rank[a.priority] - rank[b.priority] ||
      (a.deadline ? Date.parse(a.deadline) : Infinity) -
        (b.deadline ? Date.parse(b.deadline) : Infinity) ||
      a.estimateHigh - b.estimateHigh ||
      a.createdAt.localeCompare(b.createdAt)
    );
  });
  const decisions: Decision[] = ordered.map((task) => {
    const model =
      task.quality === 'high'
        ? policy.modelHigh
        : task.quality === 'economy'
          ? policy.modelEconomy
          : policy.modelBalanced;
    const cost =
      task.status === 'running' ? task.finishReserve : task.estimateHigh + task.finishReserve;
    const d: Decision = {
      taskId: task.id,
      action: 'wait',
      reason: '',
      budget: cost,
      model,
      effort: task.quality === 'high' ? 'high' : task.quality === 'economy' ? 'low' : 'medium',
      startsAt: null,
      projectedFinish: null,
      deadlineRisk: false,
      opportunity: false,
    };
    if (task.status === 'done') return { ...d, action: 'done', reason: '任务已验收' };
    if (task.status === 'review')
      return { ...d, action: 'review', reason: '等待确认验收结果，完成前不启动同一任务' };
    if (task.status === 'paused') return { ...d, reason: '已保存断点；检查进度后点击恢复' };
    if (!fresh)
      return {
        ...d,
        reason: '额度数据缺失、过期或窗口已到期，请同步后再安排',
        deadlineRisk: Boolean(
          task.deadline && Date.parse(task.deadline) <= now + task.minutes * 60_000,
        ),
      };
    if (task.status === 'running') {
      budget = Math.max(0, budget - cost);
      cursor += task.minutes * 60_000;
      return {
        ...d,
        action: 'finish',
        reason: '优先收尾并完成验证，暂缓其他任务',
        startsAt: new Date(now).toISOString(),
        projectedFinish: new Date(cursor).toISOString(),
      };
    }
    const finish = cursor + task.minutes * 60_000;
    const boundary = Math.min(
      ...(q?.windows.map((w) => (w.resetsAt ? Date.parse(w.resetsAt) : Infinity)) ?? [Infinity]),
    );
    const extra = Math.max(0, cost - budget);
    const canUseOpportunity = task.priority === 'could' && extra > 0 && extra <= opportunityBudget;
    if (cost > budget && !canUseOpportunity) {
      d.reason = `本轮可用预算不足；需要 ${cost.toFixed(1)} 个百分点，预留额度 ${policy.reservePercent}%`;
      d.deadlineRisk = Boolean(
        task.deadline && (boundary > Date.parse(task.deadline) || !Number.isFinite(boundary)),
      );
      return d;
    }
    if (finish >= boundary)
      return {
        ...d,
        reason: '预计执行跨越额度窗口，等待恢复后重新评估',
        deadlineRisk: Boolean(task.deadline && boundary >= Date.parse(task.deadline)),
      };
    if (canUseOpportunity) {
      opportunityBudget -= extra;
      budget = 0;
      d.opportunity = true;
    } else budget -= cost;
    d.action = 'ready';
    d.reason =
      task.priority === 'must'
        ? '优先保障必做任务，已计入收尾预算'
        : d.opportunity
          ? '使用你允许的临时重置机会预算'
          : '预算充足，按截止时间安排';
    d.startsAt = new Date(cursor).toISOString();
    d.projectedFinish = new Date(finish).toISOString();
    cursor = finish;
    d.deadlineRisk = Boolean(task.deadline && finish > Date.parse(task.deadline));
    return d;
  });
  return {
    decisions,
    fresh,
    remaining,
    availableBudget: initialBudget,
    unallocatedBudget: budget,
    opportunityBudget: opportunity,
    allocated: decisions
      .filter((d) => d.action === 'ready' || d.action === 'finish')
      .reduce((n, d) => n + d.budget, 0),
    readyCount: decisions.filter((d) => d.action === 'ready').length,
    nextResetAt:
      q?.windows
        .filter((w) => w.resetsAt)
        .sort((a, b) => Date.parse(a.resetsAt!) - Date.parse(b.resetsAt!))[0]?.resetsAt ?? null,
  };
}

export function burnRate(history: QuotaSnapshot[], now: number) {
  const current = history.at(-1);
  if (!current) return [];
  return current.windows.map((w) => {
    const compatible = history.filter(
      (q) =>
        q.source === current.source &&
        q.accountKey === current.accountKey &&
        q.plan === current.plan &&
        now - Date.parse(q.observedAt) <= 6 * 3600_000 &&
        q.windows.some((x) => x.id === w.id && x.resetsAt === w.resetsAt),
    );
    // Start a new segment after any restoration; never average across a reset.
    let start = compatible.length - 1;
    while (start > 0) {
      const previous = compatible[start - 1].windows.find((x) => x.id === w.id)!;
      const next = compatible[start].windows.find((x) => x.id === w.id)!;
      if (
        next.usedPercent < previous.usedPercent ||
        Date.parse(compatible[start].observedAt) - Date.parse(compatible[start - 1].observedAt) >
          30 * 60_000
      )
        break;
      start--;
    }
    const samples = compatible.slice(start);
    const first = samples[0];
    const hours = first
      ? (Date.parse(current.observedAt) - Date.parse(first.observedAt)) / 3600_000
      : 0;
    const change = first
      ? w.usedPercent - first.windows.find((x) => x.id === w.id)!.usedPercent
      : 0;
    const rate = samples.length >= 3 && hours >= 1 / 6 && change > 0 ? change / hours : null;
    const hoursLeft = w.resetsAt ? Math.max(0, (Date.parse(w.resetsAt) - now) / 3600_000) : null;
    return {
      id: w.id,
      name: w.name,
      perHour: rate,
      minutesToEmpty: rate ? ((100 - w.usedPercent) / rate) * 60 : null,
      sustainablePerHour: hoursLeft && hoursLeft > 0 ? (100 - w.usedPercent) / hoursLeft : null,
      samples: samples.length,
    };
  });
}
