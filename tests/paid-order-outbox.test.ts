import test from 'node:test';
import assert from 'node:assert/strict';
import { paidEvent, mutateOutbox, deliverClaim, validWorkFence, events } from '../src/lib/paid-order-outbox.ts';
import { handoffRequest } from '../src/lib/paid-order-handoff-route.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
const base = () => { const o = { id: 'ord_test', paymentStatus: 'paid', status: 'order_received', fulfillmentMode:'manual_hold', stripeSessionId: 'cs_test', settledAmountCents: 3900 } as OrderRecord; o.workOutbox = [paidEvent(o, '2026-10-20')]; return o; };
test('stable identity, zero-total label, no historical replay', () => { const o = base(); assert.equal(paidEvent(o, 'later').id, o.workOutbox![0].id); assert.equal(paidEvent({...o, settledAmountCents:0}, '').revenue, 'zero_total'); assert.deepEqual(events({...o,workOutbox:undefined}),[]); });
test('lease is exclusive and stale/expired acknowledgements fail', () => { let o = base(); const id = o.workOutbox![0].id; const a = mutateOutbox(o,{action:'claim',eventId:id,lane:'agent',worker:'a'},0); o=a.order; assert.throws(()=>mutateOutbox(o,{action:'claim',eventId:id,lane:'agent',worker:'b'},1)); const b=mutateOutbox(o,{action:'claim',eventId:id,lane:'agent',worker:'b'},600001); assert.equal(b.delivery.status,'ambiguous'); assert.throws(()=>mutateOutbox(b.order,{action:'ack',eventId:id,lane:'agent',token:a.delivery.token!,receipt:'run1'},600002)); assert.equal(validWorkFence(b.order,id,a.delivery.workToken!,600002),true); });
test('refund/disposition and version changes fence active work', () => { const o=base(); const id=o.workOutbox![0].id; const a=mutateOutbox(o,{action:'claim',eventId:id,lane:'agent',worker:'a'},0); for (const change of [{paymentStatus:'refunded'}, {refundedAt:'now'}, {internalDisposition:'test'}, {characterReview:{version:'new'}}]) { const altered={...a.order,...change} as OrderRecord; assert.equal(validWorkFence(altered,id,a.delivery.workToken!,1),false); assert.throws(()=>mutateOutbox(altered,{action:'ack',eventId:id,lane:'agent',token:a.delivery.token!,receipt:'run1'},1)); } });
test('owner and agent receipts are independent and ack is idempotent', () => { const o=base(); const id=o.workOutbox![0].id; const a=mutateOutbox(o,{action:'claim',eventId:id,lane:'owner',worker:'a'},0); const cmd={action:'ack' as const,eventId:id,lane:'owner' as const,token:a.delivery.token!,receipt:'telegram:123'}; const b=mutateOutbox(a.order,cmd,1); assert.equal(b.event.agent.status,'pending'); assert.equal(mutateOutbox(b.order,cmd,2).delivery.receipt,'telegram:123'); });
test('accepted response lost reconciles without resend', async () => { let o=base(); const id=o.workOutbox![0].id; let sent=0; let accepted=false; let now=0; const store={command:async (_:string,c:any)=>{const r=mutateOutbox(o,c,now);o=r.order;return r;},validate:async()=>true}; const transport={reconcile:async()=>accepted?{status:'found' as const,receipt:'run:1'}:{status:'absent' as const},deliver:async()=>{sent++;accepted=true;throw Error('response lost');}}; assert.equal(await deliverClaim(store,transport,o.id,id,'agent','a'),'ambiguous'); now=600001; assert.equal(await deliverClaim(store,transport,o.id,id,'agent','a'),'delivered'); assert.equal(sent,1); });
test('unknown reconciliation does not prevent first send',async()=>{let o=base(); const id=o.workOutbox![0].id;const store={command:async(_:string,c:any)=>{const r=mutateOutbox(o,c,0);o=r.order;return r;},validate:async()=>true};let sent=false;assert.equal(await deliverClaim(store,{reconcile:async()=>({status:'unknown'}),deliver:async()=>{sent=true;return{receipt:'bad'};}},o.id,id,'owner','a'),'delivered');assert.equal(sent,true);});
test('endpoint fail closed auth/default-off',async()=>{const deps={enabled:()=>false,authenticate:()=>false,transact:async()=>{throw Error('never');}};assert.equal((await handoffRequest(new Request('http://localhost',{method:'POST'}),'ord_test',deps)).status,401);assert.equal((await handoffRequest(new Request('http://localhost',{method:'POST'}),'ord_test',{...deps,authenticate:()=>true})).status,409);});
test('versioned revision events cannot run after approval or replacement',()=>{const o=base();o.characterReview={version:'v1',status:'changes_requested',workQueue:[{id:'revision',version:'v1',kind:'revise_character',status:'pending',at:'now'}]} as any;const claim=mutateOutbox(o,{action:'claim',eventId:'revision',lane:'agent',worker:'a'},0);assert.equal(validWorkFence(claim.order,'revision',claim.delivery.workToken!,1),true);const changed={...claim.order,characterReview:{...o.characterReview!,version:'v2'}};assert.equal(validWorkFence(changed,'revision',claim.delivery.workToken!,1),false);});
test('bounded retry enters dead letter and never transports',async()=>{const o=base();const id=o.workOutbox![0].id;o.workOutbox![0].agent={status:'ambiguous',attempts:5,expiresAt:0};const result=mutateOutbox(o,{action:'claim',eventId:id,lane:'agent',worker:'a'},1);assert.equal(result.delivery.status,'dead_letter');assert.throws(()=>mutateOutbox(result.order,{action:'claim',eventId:id,lane:'agent',worker:'a'},999999));});
test('ambiguous active lease cannot be taken by another worker',()=>{const o=base();const id=o.workOutbox![0].id;const a=mutateOutbox(o,{action:'claim',eventId:id,lane:'agent',worker:'a'},0);const b=mutateOutbox(a.order,{action:'ambiguous',eventId:id,lane:'agent',token:a.delivery.token!},1);assert.throws(()=>mutateOutbox(b.order,{action:'claim',eventId:id,lane:'agent',worker:'b'},2));});
test('long task renews exact delivered claim; expired claim cannot renew',()=>{const o=base();const id=o.workOutbox![0].id;const a=mutateOutbox(o,{action:'claim',eventId:id,lane:'agent',worker:'a'},0);const b=mutateOutbox(a.order,{action:'ack',eventId:id,lane:'agent',token:a.delivery.token!,receipt:'run1'},1);const c=mutateOutbox(b.order,{action:'renew',eventId:id,lane:'agent',token:a.delivery.token!},100000);assert.equal(validWorkFence(c.order,id,a.delivery.workToken!,150000),true);assert.equal(validWorkFence(c.order,id,a.delivery.workToken!,700001),false);assert.throws(()=>mutateOutbox(c.order,{action:'renew',eventId:id,lane:'agent',token:a.delivery.token!},700001));});
test('reconcile preserves accepted run work fence but rotates transport claim authority',()=>{
 let o=base();const id=o.workOutbox![0].id;const a=mutateOutbox(o,{action:'claim',eventId:id,lane:'agent',worker:'a'},0);
 const b=mutateOutbox(a.order,{action:'claim',eventId:id,lane:'agent',worker:'b'},600001);
 assert.notEqual(a.delivery.token,b.delivery.token);assert.equal(a.delivery.workToken,b.delivery.workToken);
 assert.equal(validWorkFence(b.order,id,a.delivery.workToken!,600002),true);
 assert.throws(()=>mutateOutbox(b.order,{action:'ack',eventId:id,lane:'agent',token:a.delivery.token!,receipt:'old'},600002));
 assert.doesNotThrow(()=>mutateOutbox(b.order,{action:'renew',eventId:id,lane:'agent',token:a.delivery.workToken!},600002));
});
test('ambiguous no-lookup transport is never blindly resent',async()=>{
 let o=base();let now=0;let sends=0;const id=o.workOutbox![0].id;
 const store={command:async(_:string,c:any)=>{const r=mutateOutbox(o,c,now);o=r.order;return r;},validate:async()=>true};
 const transport={reconcile:async()=>({status:'unknown' as const}),deliver:async()=>{sends++;throw Error('lost');}};
 assert.equal(await deliverClaim(store,transport,o.id,id,'owner','a'),'ambiguous');now=600001;
 assert.equal(await deliverClaim(store,transport,o.id,id,'owner','b'),'ambiguous');assert.equal(sends,1);
});
test('late known receipt accepted only while claim has not been replaced',()=>{
 const o=base();const id=o.workOutbox![0].id;const a=mutateOutbox(o,{action:'claim',eventId:id,lane:'owner',worker:'a'},0);
 assert.equal(mutateOutbox(a.order,{action:'ack',eventId:id,lane:'owner',token:a.delivery.token!,receipt:'telegram:42'},600001).delivery.status,'delivered');
});
test('unknown revenue, zero totals and auto orders cannot dispatch',()=>{
 for(const delta of [{settledAmountCents:0},{settledAmountCents:undefined},{fulfillmentMode:'auto'}]){
 const o={...base(),...delta} as OrderRecord;o.workOutbox=[paidEvent(o,'now')];
 for(const lane of ['owner','agent'] as const)assert.throws(()=>mutateOutbox(o,{action:'claim',eventId:o.workOutbox![0].id,lane,worker:'a'},0));
 }
});
test('owner receipt remains usable after character progresses; proof stops agent work',()=>{
 const o=base();const id=o.workOutbox![0].id;const a=mutateOutbox(o,{action:'claim',eventId:id,lane:'owner',worker:'a'},0);
 const progressed={...a.order,characterReview:{version:'v1',status:'awaiting_customer'}} as OrderRecord;
 assert.equal(mutateOutbox(progressed,{action:'ack',eventId:id,lane:'owner',token:a.delivery.token!,receipt:'telegram:2'},1).delivery.status,'delivered');
 const approved=base();approved.characterReview={version:'v1',status:'approved',workQueue:[{id:'approval',version:'v1',kind:'character_approved',status:'pending',at:'now'}]} as any;
 const b=mutateOutbox(approved,{action:'claim',eventId:'approval',lane:'agent',worker:'a'},0);
 assert.equal(validWorkFence({...b.order,proofVersion:'complete'},'approval',b.delivery.workToken!,1),false);
});
test('late agent acknowledgement requires explicit same-run recovery; never redispatches',()=>{
 const o=base();const id=o.workOutbox![0].id;const claim=mutateOutbox(o,{action:'claim',eventId:id,lane:'agent',worker:'a'},0);
 const ack=mutateOutbox(claim.order,{action:'ack',eventId:id,lane:'agent',token:claim.delivery.token!,receipt:'run:accepted'},600001);
 assert.equal(validWorkFence(ack.order,id,claim.delivery.workToken!,600002),false);
 assert.throws(()=>mutateOutbox(ack.order,{action:'renew',eventId:id,lane:'agent',token:claim.delivery.workToken!},600002));
 const command={action:'recover_accepted_run' as const,eventId:id,lane:'agent' as const,token:claim.delivery.token!,workToken:claim.delivery.workToken!,receipt:'run:accepted',attestation:'verified_same_accepted_run' as const};
 const recovered=mutateOutbox(ack.order,command,600002);
 assert.equal(validWorkFence(recovered.order,id,claim.delivery.workToken!,600003),true);
 assert.equal(recovered.delivery.status,'delivered');assert.equal(recovered.delivery.attempts,1);assert.equal(recovered.delivery.recoveries?.length,1);
 assert.throws(()=>mutateOutbox(recovered.order,command,600003));
 assert.throws(()=>mutateOutbox(recovered.order,{action:'claim',eventId:id,lane:'agent',worker:'new'},1200003));
 for(const patch of [{receipt:'wrong'},{token:'old'},{workToken:'wrong'},{lane:'owner'},{attestation:'guess'}])assert.throws(()=>mutateOutbox(ack.order,{...command,...patch} as any,600002));
 for(const patch of [{refundedAt:'now'},{paymentStatus:'refunded'},{internalDisposition:'test'},{characterReview:{version:'superseded'}},{proofVersion:'adopted'}])assert.throws(()=>mutateOutbox({...ack.order,...patch} as any,command,600002));
 const replacement=mutateOutbox(claim.order,{action:'claim',eventId:id,lane:'agent',worker:'b'},600001);
 const accepted=mutateOutbox(replacement.order,{action:'ack',eventId:id,lane:'agent',token:replacement.delivery.token!,receipt:'run:accepted'},1200002);
 assert.throws(()=>mutateOutbox(accepted.order,command,1200003));
});
