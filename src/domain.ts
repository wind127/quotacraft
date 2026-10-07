import { z } from 'zod';

export const iso = z.string().datetime({ offset: true });
export const taskInput = z
  .object({
    title: z.string().trim().min(1).max(160),
    project: z.string().trim().min(1).max(100),
    prompt: z.string().max(12000).default(''),
    workspace: z.string().max(2000).default(''),
    priority: z.enum(['must', 'should', 'could']).default('should'),
    deadline: iso.nullable().default(null),
    estimateLow: z.number().min(0.1).max(100),
    estimateHigh: z.number().min(0.1).max(100),
    finishReserve: z.number().min(0).max(50).default(2),
    minutes: z.number().int().min(1).max(1440).default(30),
    quality: z.enum(['high', 'balanced', 'economy']).default('balanced'),
    acceptance: z.string().max(2000).default(''),
  })
  .refine((t) => t.estimateHigh >= t.estimateLow, {
    message: '最高成本必须不小于最低成本',
    path: ['estimateHigh'],
  });
export type TaskInput = z.infer<typeof taskInput>;
export type TaskStatus = 'queued' | 'running' | 'paused' | 'review' | 'done';
export type Task = TaskInput & {
  id: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  checkpoint: string;
  sessionId: string | null;
  actualCost: number | null;
  completedAt: string | null;
  accepted: boolean;
  quotaBefore: Record<string, number>;
};
export const policySchema = z.object({
  reservePercent: z.number().min(0).max(80),
  staleMinutes: z.number().int().min(1).max(60),
  autoRun: z.boolean(),
  modelHigh: z.string().min(1).max(100),
  modelBalanced: z.string().min(1).max(100),
  modelEconomy: z.string().min(1).max(100),
  opportunistic: z.boolean(),
  opportunityPercent: z.number().min(0).max(20),
});
export type Policy = z.infer<typeof policySchema>;
export const defaultPolicy: Policy = {
  reservePercent: 20,
  staleMinutes: 10,
  autoRun: false,
  modelHigh: 'gpt-6.1-sol',
  modelBalanced: 'gpt-6.1-sol',
  modelEconomy: 'gpt-6-luna',
  opportunistic: false,
  opportunityPercent: 5,
};
export const windowSchema = z.object({
  id: z.string().min(1).max(150),
  name: z.string().min(1).max(100),
  usedPercent: z.number().min(0).max(100),
  windowMinutes: z.number().int().min(1),
  resetsAt: iso.nullable(),
});
export type QuotaWindow = z.infer<typeof windowSchema>;
export type QuotaSnapshot = {
  id: string;
  observedAt: string;
  source: 'codex' | 'manual' | 'demo';
  accountKey: string;
  plan: string | null;
  windows: QuotaWindow[];
};
export const signalSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(300),
  kind: z.enum(['hint', 'announced', 'confirmed', 'banked', 'incident']),
  occurredAt: iso,
  resetAt: iso.nullable().default(null),
  scope: z.enum(['all', 'paid', 'unknown', 'limited']).default('unknown'),
  sourceUrl: z
    .string()
    .url()
    .refine((s) => s.startsWith('https://'), '必须为 HTTPS 链接'),
  evidence: z.string().max(3000).default(''),
  origin: z.enum(['manual', 'x', 'demo']).default('manual'),
});
export type Signal = z.infer<typeof signalSchema> & { knownAt: string };
export type Notice = {
  id: string;
  kind: string;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
};
export type Decision = {
  taskId: string;
  action: 'ready' | 'wait' | 'finish' | 'review' | 'done';
  reason: string;
  budget: number;
  model: string;
  effort: string;
  startsAt: string | null;
  projectedFinish: string | null;
  deadlineRisk: boolean;
  opportunity: boolean;
};
