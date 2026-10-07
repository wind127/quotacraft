import { describe, it, expect } from 'vitest';
import {
  defaultPolicy,
  taskInput,
  type Task,
  type QuotaSnapshot,
  type Signal,
} from '../src/domain';
import { makePlan, burnRate, forecast } from '../src/planner';
import { normalizeLimits } from '../src/codex';
import { classifyPost } from '../src/signals';
const now = Date.parse('2026-10-07T04:00:00Z');
const iso = (delta = 0) => new Date(now + delta).toISOString();
function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    ...taskInput.parse({ title: id, project: 'test', estimateLow: 3, estimateHigh: 6 }),
    id,
    status: 'queued',
    createdAt: iso(),
    updatedAt: iso(),
    checkpoint: '',
    sessionId: null,
    actualCost: null,
    completedAt: null,
    accepted: false,
    quotaBefore: {},
    ...patch,
  };
}
function quota(used = 40): QuotaSnapshot {
  return {
    id: 'q',
    observedAt: iso(),
    source: 'manual',
    accountKey: 'a',
    plan: 'plus',
    windows: [
      {
        id: 'weekly',
        name: 'weekly',
        usedPercent: used,
        windowMinutes: 10080,
        resetsAt: iso(3 * 86400_000),
      },
    ],
  };
}
function signal(patch: Partial<Signal> = {}): Signal {
  return {
    id: 's',
    title: 'Reset',
    kind: 'announced',
    scope: 'all',
    occurredAt: iso(-3600_000),
    knownAt: iso(-3600_000),
    resetAt: iso(3600_000),
    sourceUrl: 'https://example.com/reset',
    evidence: '',
    origin: 'manual',
    ...patch,
  };
}
describe('deadline-aware multi-window scheduling', () => {
  it('prioritizes must-do work and its verification reserve over cheap optional tasks', () => {
    const plan = makePlan(
      [
        task('optional', { priority: 'could', estimateHigh: 2 }),
        task('must', { priority: 'must', estimateHigh: 25, finishReserve: 10 }),
      ],
      quota(60),
      defaultPolicy,
      [],
      now,
    );
    expect(plan.decisions[0].taskId).toBe('must');
    expect(plan.decisions[0].action).toBe('wait');
    expect(plan.decisions[1].action).toBe('ready');
    expect(plan.decisions[0].budget).toBe(35);
  });
  it('orders same-priority tasks by deadline and accounts for serial execution', () => {
    const plan = makePlan(
      [task('later', { deadline: iso(7200_000) }), task('soon', { deadline: iso(1800_000) })],
      quota(),
      defaultPolicy,
      [],
      now,
    );
    expect(plan.decisions.map((d) => d.taskId)).toEqual(['soon', 'later']);
    expect(plan.decisions[1].startsAt).toBe(iso(1800_000));
  });
  it('keeps total admissions within the tightest window and includes finishing budgets', () => {
    const q = quota(20);
    q.windows.push({
      id: 'short',
      name: 'short',
      usedPercent: 70,
      windowMinutes: 300,
      resetsAt: iso(3600_000),
    });
    const plan = makePlan([task('a'), task('b')], q, defaultPolicy, [], now);
    expect(plan.availableBudget).toBe(10);
    expect(plan.readyCount).toBe(1);
    expect(plan.allocated).toBe(8);
  });
  it('never admits work with missing, stale, future or expired readings', () => {
    for (const q of [
      null,
      { ...quota(), observedAt: iso(-11 * 60_000) },
      { ...quota(), observedAt: iso(2 * 60_000) },
      { ...quota(), windows: [{ ...quota().windows[0], resetsAt: iso(-1) }] },
    ])
      expect(makePlan([task('a')], q, defaultPolicy, [], now).readyCount).toBe(0);
  });
  it('flags overdue tasks and tasks whose projected duration crosses a reset', () => {
    const q = quota();
    q.windows[0].resetsAt = iso(60_000);
    const d = makePlan([task('a', { deadline: iso(-60_000) })], q, defaultPolicy, [], now)
      .decisions[0];
    expect(d.action).toBe('wait');
    expect(d.deadlineRisk).toBe(true);
  });
  it('reserves current task finishing capacity first', () => {
    const plan = makePlan(
      [task('queued'), task('running', { status: 'running', finishReserve: 8 })],
      quota(65),
      defaultPolicy,
      [],
      now,
    );
    expect(plan.decisions[0].action).toBe('finish');
    expect(plan.decisions[1].action).toBe('wait');
  });
  it('does not expand mandatory budgets based on forecast or banked resets', () => {
    const p = { ...defaultPolicy, opportunistic: true };
    for (const s of [
      signal({ kind: 'hint' }),
      signal({ kind: 'banked' }),
      signal({ origin: 'demo' }),
      signal({ scope: 'paid' }),
    ])
      expect(
        makePlan(
          [task('a', { estimateHigh: 12, finishReserve: 0, priority: 'could' })],
          quota(70),
          p,
          [s],
          now,
        ).readyCount,
      ).toBe(0);
    expect(
      makePlan(
        [task('a', { estimateHigh: 12, finishReserve: 0, priority: 'must' })],
        quota(70),
        p,
        [signal()],
        now,
      ).readyCount,
    ).toBe(0);
  });
  it('releases only opted-in opportunity budget, only for optional work', () => {
    const plan = makePlan(
      [
        task('a', { estimateHigh: 12, finishReserve: 0, priority: 'could' }),
        task('b', { estimateHigh: 3, finishReserve: 0, priority: 'could' }),
      ],
      quota(70),
      { ...defaultPolicy, opportunistic: true, opportunityPercent: 5 },
      [signal()],
      now,
    );
    expect(plan.allocated).toBeLessThanOrEqual(15);
    expect(plan.decisions.some((d) => d.opportunity)).toBe(true);
  });
  it('preserves high quality model and effort', () => {
    const d = makePlan([task('a', { quality: 'high' })], quota(70), defaultPolicy, [], now)
      .decisions[0];
    expect(d.model).toBe(defaultPolicy.modelHigh);
    expect(d.effort).toBe('high');
  });
});
describe('quota ingestion and trend boundaries', () => {
  it('prefers multi-bucket limits and ignores null, invalid or absent windows', () => {
    expect(
      normalizeLimits({
        rateLimits: { primary: { usedPercent: 99 } },
        rateLimitsByLimitId: {
          codex: {
            primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: now / 1000 + 3600 },
            secondary: null,
          },
          other: { primary: { usedPercent: null, windowDurationMins: 300 } },
        },
      }),
    ).toHaveLength(1);
    expect(normalizeLimits({})).toEqual([]);
  });
  it('requires enough samples and never extrapolates across a restoration', () => {
    const samples = [0, 1, 2].map((i) => ({
      ...quota(10 + i * 2),
      id: String(i),
      observedAt: iso((i - 2) * 5 * 60_000),
    }));
    expect(burnRate(samples, now)[0].perHour).toBe(24);
    samples.push({ ...quota(1), observedAt: iso(60_000) });
    expect(burnRate(samples, now)[0].perHour).toBeNull();
  });
  it('isolates account, plan and reset changes', () => {
    const samples = [0, 1, 2].map((i) => ({
      ...quota(10 + i * 2),
      observedAt: iso((i - 2) * 5 * 60_000),
    }));
    samples[2].accountKey = 'new';
    expect(burnRate(samples, now)[0].perHour).toBeNull();
  });
});
describe('honest public reset forecasting', () => {
  it('does not manufacture probabilities from sparse or demo data', () => {
    expect(forecast([signal({ kind: 'confirmed' })], now).probability24h).toBeNull();
    expect(forecast([signal({ kind: 'confirmed', origin: 'demo' })], now).sampleCount).toBe(0);
  });
  it('deduplicates rollout clusters and excludes future knowledge and restricted scopes', () => {
    const s = signal({ kind: 'confirmed', occurredAt: iso(-86400_000), knownAt: iso(-86400_000) });
    const f = forecast(
      [
        s,
        { ...s, id: 'dup', occurredAt: iso(-86300_000) },
        { ...s, id: 'future', knownAt: iso(60_000) },
        { ...s, id: 'paid', scope: 'paid' },
      ],
      now,
    );
    expect(f.sampleCount).toBe(0);
  });
  it('produces monotone smoothed estimates from sufficient conditional history', () => {
    const s = Array.from({ length: 14 }, (_, i) =>
      signal({
        id: String(i),
        kind: 'confirmed',
        occurredAt: iso(-(14 - i) * 4 * 86400_000),
        knownAt: iso(-(14 - i) * 4 * 86400_000),
      }),
    );
    const f = forecast(s, now - 3 * 86400_000);
    expect(f.probability24h).not.toBeNull();
    expect(f.probability24h!).toBeLessThanOrEqual(f.probability72h!);
    expect(f.probability72h!).toBeLessThanOrEqual(f.probability7d!);
    expect(f.probability7d!).toBeLessThan(1);
  });
  it('keeps vague or negative statements out of confirmed/actionable announcements', () => {
    for (const text of [
      "We won't reset your limits",
      'Reset coming soon',
      'We will not reset everyone today',
      'We have not reset limits',
    ]) {
      const s = classifyPost('123', text, iso());
      expect(s?.kind).not.toBe('confirmed');
      expect(s?.kind).not.toBe('announced');
    }
    expect(classifyPost('123', 'A banked reset credit for all users', iso())?.kind).toBe('banked');
    expect(
      classifyPost('123', 'We will reset for all users at 2026-10-08T10:00:00Z', iso())?.kind,
    ).toBe('announced');
  });
});
