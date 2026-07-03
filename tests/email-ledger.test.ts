import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendEmailLedgerEvent, listEmailLedgerEvents, summarizeEmailLedgerForOrder } from '../src/lib/email-ledger.ts';

function tmpLedgerDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-email-ledger-'));
  process.env.HSB_EMAIL_LEDGER_DIR = dir;
  return dir;
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_EMAIL_LEDGER_DIR;
}

test('email ledger records sent/delivered/failed events without provider payload bodies', async () => {
  const dir = tmpLedgerDir();
  try {
    await appendEmailLedgerEvent({
      orderId: 'ord_email_1',
      emailType: 'proof',
      recipient: 'buyer@example.com',
      resendMessageId: 'msg_123',
      status: 'sent',
      occurredAt: '2026-07-02T12:00:00.000Z',
      providerPayload: { html: '<p>secret body</p>', id: 'msg_123' },
    });
    await appendEmailLedgerEvent({
      orderId: 'ord_email_1',
      emailType: 'proof',
      recipient: 'buyer@example.com',
      resendMessageId: 'msg_123',
      status: 'failed',
      occurredAt: '2026-07-02T12:01:00.000Z',
      error: 'Mailbox unavailable with a very long diagnostic that should be bounded'.repeat(8),
    });

    const events = await listEmailLedgerEvents('ord_email_1');
    assert.equal(events.length, 2);
    assert.equal(events[0].providerPayloadHash?.length, 64);
    assert.equal('providerPayload' in events[0], false);
    assert(events[1].error && events[1].error.length <= 240);

    const summary = await summarizeEmailLedgerForOrder('ord_email_1');
    assert.equal(summary.lastProofStatus, 'failed');
    assert.equal(summary.hasProofSent, true);
    assert.equal(summary.hasFailure, true);
  } finally {
    cleanup(dir);
  }
});
