import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverPlans } from '../scripts/plan-paid-order-handoff.ts';
import { paidEvent } from '../src/lib/paid-order-outbox.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
test('offline discovery excludes historical paid, plans no secret/customer data, cannot activate runner',()=>{const order={id:'ord_plan',status:'order_received',fulfillmentMode:'manual_hold',settledAmountCents:3900,paymentStatus:'paid',stripeSessionId:'cs_plan',email:'secret@example.invalid',childName:'PRIVATE'} as OrderRecord;assert.deepEqual(discoverPlans([order],'123','ops'),[]);order.workOutbox=[paidEvent(order,'now')];const result=discoverPlans([order],'123','ops');assert.equal(result.length,1);assert.ok(result[0].owner.args.includes('--dry-run'));assert.equal(result[0].agent.executableAllowed,false);assert.equal(JSON.stringify(result).includes('PRIVATE'),false);assert.equal(JSON.stringify(result).includes('secret@example.invalid'),false);});
