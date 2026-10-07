import { createHash } from 'node:crypto';
import type { Signal } from './domain.js';

export function classifyPost(
  id: string,
  text: string,
  createdAt: string,
  now = new Date().toISOString(),
): Signal | null {
  if (!/reset|limit|quota|credit/i.test(text)) return null;
  const scope = /all users|everyone|everybody/i.test(text)
    ? 'all'
    : /paid (users|accounts)/i.test(text)
      ? 'paid'
      : 'unknown';
  const banked = /banked|reset credit|bank.*reset/i.test(text);
  const negated =
    /no reset|not reset|won't.*reset|will not.*reset|not.*resetting|haven't.*reset|never.*reset/i.test(
      text,
    );
  const confirmed =
    !negated &&
    /(?:just|have|has) (?:been )?reset|reset (?:your|everyone|all).*limits|limits (?:are|have been) reset/i.test(
      text,
    );
  // Only explicit absolute timestamps are actionable. "Tomorrow" or "soon" remains a hint.
  const stamp = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})/)?.[0];
  const resetAt =
    stamp && Number.isFinite(Date.parse(stamp)) ? new Date(stamp).toISOString() : null;
  return {
    id: `x:${id}`,
    title: text.slice(0, 160),
    kind: banked
      ? 'banked'
      : confirmed
        ? 'confirmed'
        : !negated && resetAt && /will|going to|scheduled/i.test(text)
          ? 'announced'
          : 'hint',
    occurredAt: createdAt,
    knownAt: now,
    resetAt,
    scope,
    sourceUrl: `https://x.com/thsottiaux/status/${id}`,
    evidence: text.slice(0, 3000),
    origin: 'x',
  };
}
export async function readTibo(): Promise<Signal[]> {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) throw new Error('未配置 X_BEARER_TOKEN；可手动添加原帖，或启用社区预测源');
  const response = await fetch(
    'https://api.x.com/2/users/1953337039510003712/tweets?max_results=25&tweet.fields=created_at&exclude=retweets',
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(12_000),
      redirect: 'error',
    },
  );
  if (!response.ok) throw new Error(`X API 返回 ${response.status}；请检查权限、余额和限流`);
  const body = (await response.json()) as {
    data?: { id: string; text: string; created_at: string }[];
  };
  return (body.data ?? []).flatMap((p) => {
    if (!p.created_at || !/^\d+$/.test(p.id)) return [];
    const s = classifyPost(p.id, p.text, p.created_at);
    return s ? [s] : [];
  });
}
export async function readCommunityForecast() {
  const response = await fetch('https://codex.gussuriworks.com/api/current?locale=en', {
    signal: AbortSignal.timeout(12_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`社区预测源返回 ${response.status}`);
  const body = (await response.json()) as any;
  const p24 = body.viewModel?.probability24h;
  const p72 = body.viewModel?.probability72h;
  if (
    body.schemaVersion !== 'public-v1' ||
    typeof p24 !== 'number' ||
    p24 < 0 ||
    p24 > 1 ||
    typeof p72 !== 'number' ||
    p72 < 0 ||
    p72 > 1 ||
    !Number.isFinite(Date.parse(body.checkedAt)) ||
    Date.now() - Date.parse(body.checkedAt) > 3600_000 ||
    Date.parse(body.checkedAt) > Date.now() + 60_000
  )
    throw new Error('社区预测数据缺失、过期或格式不支持');
  return {
    probability24h: p24,
    probability72h: p72,
    checkedAt: body.checkedAt,
    receivedAt: new Date().toISOString(),
    sourceUrl: 'https://codex.gussuriworks.com/en',
    disclaimer: '第三方估计，仅作参考，不参与任务准入或额度预算',
  };
}
export function signalKey(s: Signal) {
  return createHash('sha256')
    .update(JSON.stringify([s.kind, s.resetAt, s.evidence]))
    .digest('hex')
    .slice(0, 12);
}
