import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOrderRecord, persistOrder, settleOrderPayment, getOrder } from '../src/lib/orders.ts';
test('paid transition atomically creates once; replay preserves consumed receipt; default-off and terminal fail closed', async()=>{
 process.env.HSB_ORDER_STORE_DIR=await mkdtemp(path.join(os.tmpdir(),'hsb-outbox-'));
 process.env.HSB_REQUIRE_DURABLE_PERSISTENCE='false';
 const previous=process.env.HSB_PAID_ORDER_OUTBOX_ENABLED;
 try {
  for (const enabled of [false,true]) {
   process.env.HSB_PAID_ORDER_OUTBOX_ENABLED=String(enabled);
   const id=`ord_outbox_${enabled}`;
   const order={...createOrderRecord({childName:'Synthetic',bookFormat:'digital',email:'synthetic@example.invalid'},{id,fulfillmentMode:'manual_hold'}), stripeSessionId:`cs_${enabled}`};
   await persistOrder(order);
   const first=await settleOrderPayment(id,{stripeSessionId:order.stripeSessionId,settledAmountCents:0});
   assert.equal(first?.transitionedToPaid,true);
   assert.equal(first?.order.workOutbox?.length ?? 0,enabled?1:0);
   if(enabled){const stored=(await getOrder(id))!; stored.workOutbox![0].owner={status:'delivered',attempts:1,receipt:'telegram:42'}; await persistOrder(stored);}
   const replay=await settleOrderPayment(id,{stripeSessionId:order.stripeSessionId,settledAmountCents:0});
   assert.equal(replay?.transitionedToPaid,false);
   if(enabled) assert.equal(replay?.order.workOutbox![0].owner.receipt,'telegram:42');
  }
 } finally { if(previous===undefined) delete process.env.HSB_PAID_ORDER_OUTBOX_ENABLED; else process.env.HSB_PAID_ORDER_OUTBOX_ENABLED=previous; }
});
test('enrolled and character-reviewed orders cannot be converted to auto by admin retry',async()=>{
 const {prepareOrderForAdminFulfillmentRetry}=await import('../src/lib/orders.ts');
 process.env.HSB_ORDER_STORE_DIR=await mkdtemp(path.join(os.tmpdir(),'hsb-retry-fence-'));process.env.HSB_REQUIRE_DURABLE_PERSISTENCE='false';
 for(const mode of ['enrolled','approved']){
 const id=`ord_retry_${mode}`;const order={...createOrderRecord({childName:'Synthetic',bookFormat:'digital',email:'synthetic@example.invalid'},{id,fulfillmentMode:'manual_hold'}),paymentStatus:'paid' as const};
 if(mode==='enrolled')order.workOutbox=[(await import('../src/lib/paid-order-outbox.ts')).paidEvent(order,'now')];
 else order.characterReview={version:'v1',status:'approved',workQueue:[]} as any;
 await persistOrder(order);assert.equal(await prepareOrderForAdminFulfillmentRetry(id,()=>true),null);assert.equal((await getOrder(id))?.fulfillmentMode,'manual_hold');
 }
});
