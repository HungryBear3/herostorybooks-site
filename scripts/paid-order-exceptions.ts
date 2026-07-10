import { listOrders, type OrderRecord } from '../src/lib/orders.ts';
import { deriveOrderAttention, deriveOrderStage, type DerivedOrderAttention, type DerivedOrderStage } from '../src/lib/order-stage.ts';

export interface PaidOrderException {
  orderId: string;
  stage: DerivedOrderStage;
  severity: DerivedOrderAttention['severity'];
  reason: string;
  queue: string;
  nextActionOwner: string;
  bookFormat: string;
  fulfillmentStatus: string | null;
  orderStatus: string | null;
  pageArtifactCount: number;
  hasStoryArtifact: boolean;
  hasProofToken: boolean;
  hasShippingAddress: boolean;
  updatedAt: string;
}

export interface PaidOrderExceptionsReport {
  capturedAt: string;
  totalOrders: number;
  paidOrders: number;
  exceptions: PaidOrderException[];
  toMarkdown(): string;
}

function makeException(order: OrderRecord, now: string): PaidOrderException | null {
  if (order.paymentStatus !== 'paid' && !order.refundedAt) return null;
  const attention = deriveOrderAttention(order, { now });
  if (attention.severity === 'none') return null;
  return {
    orderId: order.id,
    stage: deriveOrderStage(order),
    severity: attention.severity,
    reason: attention.reason,
    queue: attention.queue,
    nextActionOwner: attention.nextActionOwner,
    bookFormat: order.bookFormat,
    fulfillmentStatus: order.fulfillmentStatus ?? null,
    orderStatus: order.status ?? null,
    pageArtifactCount: order.pageArtifacts?.length ?? 0,
    hasStoryArtifact: Boolean(order.storyArtifactUrl),
    hasProofToken: Boolean(order.proofApprovalToken),
    hasShippingAddress: Boolean(order.shippingAddress),
    updatedAt: order.updatedAt,
  };
}

function reportToMarkdown(report: Omit<PaidOrderExceptionsReport, 'toMarkdown'>): string {
  const lines = [
    `# HSB paid-order exceptions — ${report.capturedAt}`,
    '',
    `- totalOrders: ${report.totalOrders}`,
    `- paidOrders: ${report.paidOrders}`,
    `- exceptions: ${report.exceptions.length}`,
    '',
  ];
  if (report.exceptions.length === 0) {
    lines.push('No paid-order exceptions detected.');
  } else {
    for (const item of report.exceptions) {
      lines.push(`- ${item.severity.toUpperCase()} ${item.orderId}: ${item.reason}`);
      lines.push(`  - stage: ${item.stage}`);
      lines.push(`  - queue: ${item.queue}; owner: ${item.nextActionOwner}`);
      lines.push(`  - format/status: ${item.bookFormat}; fulfillment=${item.fulfillmentStatus ?? '—'}; order=${item.orderStatus ?? '—'}`);
      lines.push(`  - artifacts: pages=${item.pageArtifactCount}; story=${item.hasStoryArtifact}; proofToken=${item.hasProofToken}; shipping=${item.hasShippingAddress}`);
      lines.push(`  - updatedAt: ${item.updatedAt}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function buildPaidOrderExceptionsReport(
  orders: OrderRecord[],
  options: { now?: string | Date } = {},
): PaidOrderExceptionsReport {
  const capturedAt = options.now instanceof Date ? options.now.toISOString() : options.now ?? new Date().toISOString();
  const base = {
    capturedAt,
    totalOrders: orders.length,
    paidOrders: orders.filter((order) => order.paymentStatus === 'paid').length,
    exceptions: orders.map((order) => makeException(order, capturedAt)).filter(Boolean) as PaidOrderException[],
  };
  return {
    ...base,
    toMarkdown: () => reportToMarkdown(base),
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const report = buildPaidOrderExceptionsReport(await listOrders());
  if (args.has('--markdown')) {
    process.stdout.write(report.toMarkdown());
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
