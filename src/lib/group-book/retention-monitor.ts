import { readPrivateObject } from './store.ts';
import { groupBookDispatchSlotPath, groupBookHeartbeatPath, utcDay } from './retention.ts';

/**
 * Deterministic retention monitor (ops successor DESIGN O6). Reads only the
 * exact durable slot/heartbeat keys for the expected UTC day (no listing, no
 * customer objects) and decides alerts from them plus an optional probe HTTP
 * status. Notifications are dry-run records: no delivery channel exists here.
 */
const DISPATCH_MINUTE_UTC = 5 * 60 + 41; // vercel.json `41 5 * * *`
export const MONITOR_GRACE_MS = 30 * 60 * 1000;
/** Route maxDuration (300s) plus margin: a slot older than this without a heartbeat is stale. */
export const MONITOR_STALE_MS = 360 * 1000;

export interface MonitorSlot { day: string; startedAt: string }
export interface MonitorHeartbeat { day: string; status: 'ok' | 'attention'; attention: string[]; finishedAt: string }
export type MonitorAlertKind = 'missed_dispatch' | 'stale_in_progress' | 'attention' | 'http_5xx' | 'monitor_read_unavailable';
export interface MonitorAlert { kind: MonitorAlertKind; fingerprint: string; day: string; delivery: 'dry_run' }

const isIsoTime = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v));

export function expectedDispatchDay(now: number): string {
  const today = utcDay(now);
  const dueToday = Date.parse(`${today}T00:00:00.000Z`) + DISPATCH_MINUTE_UTC * 60 * 1000 + MONITOR_GRACE_MS;
  return now >= dueToday ? today : utcDay(now - 24 * 60 * 60 * 1000);
}

export async function loadRetentionMonitorInputs(now: number): Promise<{ slots: MonitorSlot[]; heartbeats: MonitorHeartbeat[]; readFailed: boolean }> {
  const days = [...new Set([utcDay(now), expectedDispatchDay(now)])];
  const slots: MonitorSlot[] = [];
  const heartbeats: MonitorHeartbeat[] = [];
  let readFailed = false;
  for (const day of days) {
    try {
      const slot = await readPrivateObject(groupBookDispatchSlotPath(day));
      if (slot.state === 'found') {
        const v = slot.value as { startedAt?: unknown };
        if (isIsoTime(v?.startedAt)) slots.push({ day, startedAt: v.startedAt }); else readFailed = true;
      } else if (slot.state !== 'absent') readFailed = true;
      const hb = await readPrivateObject(groupBookHeartbeatPath(day));
      if (hb.state === 'found') {
        const v = hb.value as { status?: unknown; attention?: unknown; finishedAt?: unknown };
        if ((v?.status === 'ok' || v?.status === 'attention') && Array.isArray(v.attention) && v.attention.every((a) => typeof a === 'string' && /^[a-z_]{1,40}$/.test(a)) && isIsoTime(v.finishedAt)) {
          heartbeats.push({ day, status: v.status, attention: v.attention as string[], finishedAt: v.finishedAt });
        } else readFailed = true;
      } else if (hb.state !== 'absent') readFailed = true;
    } catch {
      readFailed = true;
    }
  }
  return { slots, heartbeats, readFailed };
}

/**
 * Pure decision. `fingerprints` is every currently-present fault; an alert is
 * emitted only for a fault whose fingerprint was not already present, so an
 * unchanged persisting fault alerts once. A healthy cycle clears fingerprints.
 */
export function evaluateRetentionMonitor(input: {
  now: number;
  slots: MonitorSlot[];
  heartbeats: MonitorHeartbeat[];
  httpStatus: number | null;
  priorFingerprints: string[];
  readFailed?: boolean;
}): { expectedDay: string; alerts: MonitorAlert[]; fingerprints: string[] } {
  const day = expectedDispatchDay(input.now);
  const current = new Map<string, MonitorAlertKind>();
  if (input.readFailed) current.set('monitor_read_unavailable', 'monitor_read_unavailable');
  const slot = input.slots.find((row) => row.day === day);
  const heartbeat = input.heartbeats.find((row) => row.day === day);
  if (!slot && !heartbeat) current.set('missed_dispatch', 'missed_dispatch');
  else if (!heartbeat && slot && !(input.now - Date.parse(slot.startedAt) <= MONITOR_STALE_MS)) current.set('stale_in_progress', 'stale_in_progress');
  if (heartbeat && heartbeat.status !== 'ok') current.set(`attention:${[...heartbeat.attention].sort().join(',')}`, 'attention');
  if (input.httpStatus !== null && input.httpStatus >= 500) current.set(`http_5xx:${input.httpStatus}`, 'http_5xx');
  const prior = new Set(input.priorFingerprints);
  const alerts = [...current].filter(([fingerprint]) => !prior.has(fingerprint))
    .map(([fingerprint, kind]) => ({ kind, fingerprint, day, delivery: 'dry_run' as const }));
  return { expectedDay: day, alerts, fingerprints: [...current.keys()].sort() };
}
