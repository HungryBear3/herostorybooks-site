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
  const candidates = leads.filter((lead) => isAbandonedCandidate(lead, now, thresholdMs));

  const result: SweepResult = {
    eligible: candidates.length,
    sent: 0,
    failed: 0,
    skipped: 0,
    dryRun,
  };

  for (const lead of candidates) {
    if (dryRun) {
      console.log(`[dry-run] would send to ${lead.email} (last active: ${lead.updatedAt})`);
      result.skipped += 1;
      continue;
    }

    try {
      await _onSend(lead);
      await _onMark(lead);
      result.sent += 1;
      console.log(`Sent recovery email to ${lead.email}`);
    } catch (error) {
      result.failed += 1;
      console.error(`Failed to send to ${lead.email}:`, error instanceof Error ? error.message : error);
    }
  }

  return result;
}
