import {
  isAbandonedCandidate,
  listRecoveryLeads,
  markRecoveryLeadAbandoned,
  type RecoveryLead,
} from './recovery.ts';
import { sendAbandonedCheckoutEmail } from './recovery-email.ts';

export interface SweepResult {
  eligible: number;
  sent: number;
  failed: number;
  skipped: number;
  dryRun: boolean;
}

export interface SweepOptions {
  dryRun?: boolean;
  thresholdMs?: number;
  now?: string;
  // Injectable for tests
  _leads?: RecoveryLead[];
  _onSend?: (lead: RecoveryLead) => Promise<{ id: string }>;
  _onMark?: (lead: RecoveryLead) => Promise<void>;
}

export async function runRecoverySweep(options: SweepOptions = {}): Promise<SweepResult> {
  const {
    dryRun = false,
    thresholdMs,
    now,
    _leads,
    _onSend = sendAbandonedCheckoutEmail,
    _onMark = markRecoveryLeadAbandoned,
  } = options;

  const leads = _leads ?? await listRecoveryLeads();
  const candidates = leads.filter(l => isAbandonedCandidate(l, now, thresholdMs));

  const result: SweepResult = { eligible: candidates.length, sent: 0, failed: 0, skipped: 0, dryRun };

  if (dryRun) {
    for (const lead of candidates) {
      console.log(`[dry-run] would send to ${lead.email} (last active: ${lead.updatedAt})`);
    }
    result.skipped = candidates.length;
    return result;
  }

  for (const lead of candidates) {
    try {
      await _onSend(lead);
      await _onMark(lead);
      result.sent++;
      console.log(`Sent recovery email to ${lead.email}`);
    } catch (err) {
      result.failed++;
      console.error(`Failed to send to ${lead.email}:`, err instanceof Error ? err.message : err);
    }
  }

  return result;
}
