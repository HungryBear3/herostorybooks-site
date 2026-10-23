/** Offline discovery/planning only. Never invokes OpenClaw or networks.
 * Input is an explicit synthetic/private snapshot export, not a historical paid scan. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { events, eligible, type WorkEvent } from '../src/lib/paid-order-outbox.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
export function openClawPlan(orderId: string, event: WorkEvent, owner: string, agent: string) {
 if (!/^ord_[\w-]{1,100}$/.test(orderId) || ! /^-?\d{1,20}$/.test(owner) || !/^[\w-]{1,64}$/.test(agent)) throw Error('invalid_destination');
 const task = `HSB task ${event.id}; order ${orderId}; kind ${event.kind}; version ${event.version ?? 'initial'}. Fetch private intake only with authenticated access. Revalidate authoritative paid state and claim token before work and output adoption. Prepare only: no customer release, email, payment, refund or printing.`;
 return { eventId: event.id, owner: { executable: 'openclaw', args: ['message','send','--channel','telegram','--target',owner,'--message',`HSB paid-order work ready: ${orderId}; ${event.kind}. Event ${event.id}.`,'--json','--dry-run'] },
   agent: { rpc: 'agent', params: { agentId: agent, message: task, idempotencyKey: event.id }, executableAllowed:false },
   activationBlocked: 'Gateway agent idempotency is not durable acceptance reconciliation. No automatic resend on ambiguous outcome; adapter remains blocked.' };
}
export function discoverPlans(orders: OrderRecord[], owner: string, agent: string) {
 if (orders.length > 100) throw Error('batch_limit');
 return orders.flatMap(order => events(order).filter(e=>((eligible(order,e,'owner') && e.owner.status!=='delivered') || (eligible(order,e,'agent') && e.agent.status!=='delivered'))).map(event=>openClawPlan(order.id,event,owner,agent)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 const [file,owner,agent,...extra]=process.argv.slice(2); if(!file||!owner||!agent||extra.length) throw Error('Usage: plan-paid-order-handoff.ts SNAPSHOTS.json OWNER_CHAT_ID AGENT_ID (offline only)');
 const bytes=await readFile(file); if(bytes.length>1024*1024)throw Error('batch_too_large');
 console.log(JSON.stringify({mode:'dry_run_not_dispatched',plans:discoverPlans(JSON.parse(bytes.toString()),owner,agent)},null,2));
}
