import test from 'node:test';
import assert from 'node:assert/strict';
import { groupBookInvites, resolveGroupBookInviteState } from '../src/lib/group-book/config.ts';
import { ownsGroupBookInvite } from '../src/lib/group-book/ownership.ts';
const legacy={token:'a'.repeat(32),cohortId:'room-a',familySlotId:'family-a',cohortLabel:'Room A',expiresAt:'2099-01-01T00:00:00Z'};
const owner={issuer:'https://hsb.example/auth/v1',subject:'parent-a'};
test('configuration preserves identity binding instead of dropping it',()=>{
 assert.deepEqual(groupBookInvites(JSON.stringify([{...legacy,owner}]))[0]?.owner,owner);
});
test('malformed owner binding fails closed instead of becoming a bearer invite',()=>{
 for(const bad of [null,{}, {issuer:owner.issuer}, {issuer:owner.issuer,subject:''}]) assert.deepEqual(groupBookInvites(JSON.stringify([{...legacy,owner:bad}])),[]);
});
test('legacy access is preserved without claiming verified identity',()=>assert.equal(ownsGroupBookInvite(legacy,null),true));
test('shared invite alone cannot access an identity-bound family',()=>assert.equal(ownsGroupBookInvite({...legacy,owner},null),false));
test('real resolver gates bound access and retains expiry, revocation and cohort isolation',()=>{
 const before=process.env.GROUP_BOOK_INVITES_JSON;
 try {
  process.env.GROUP_BOOK_INVITES_JSON=JSON.stringify([{...legacy,owner},{...legacy,token:'b'.repeat(32),familySlotId:'family-b',cohortId:'room-b',owner:{...owner,subject:'parent-b'}}]);
  const now=Date.parse('2026-10-23T00:00:00Z');
  const principal={...owner,emailVerified:true};
  assert.equal(resolveGroupBookInviteState(legacy.token,now).state,'unknown');
  assert.equal(resolveGroupBookInviteState(legacy.token,now,principal).state,'active');
  assert.equal(resolveGroupBookInviteState('b'.repeat(32),now,principal).state,'unknown');
  assert.equal(resolveGroupBookInviteState(legacy.token,Date.parse(legacy.expiresAt),principal).state,'expired');
  process.env.GROUP_BOOK_INVITES_JSON=JSON.stringify([{...legacy,owner,revokedAt:'2026-01-01T00:00:00Z'}]);
  assert.equal(resolveGroupBookInviteState(legacy.token,now,principal).state,'revoked');
  process.env.GROUP_BOOK_INVITES_JSON=JSON.stringify([legacy]);
  assert.equal(resolveGroupBookInviteState(legacy.token,now).state,'active');
 } finally { if(before===undefined)delete process.env.GROUP_BOOK_INVITES_JSON;else process.env.GROUP_BOOK_INVITES_JSON=before; }
});
test('verified exact issuer and subject grant only their bound family',()=>{
 assert.equal(ownsGroupBookInvite({...legacy,owner},{...owner,emailVerified:true}),true);
 assert.equal(ownsGroupBookInvite({...legacy,owner},{...owner,subject:'parent-b',emailVerified:true}),false);
 assert.equal(ownsGroupBookInvite({...legacy,owner},{...owner,issuer:'https://other.example/auth/v1',emailVerified:true}),false);
 assert.equal(ownsGroupBookInvite({...legacy,owner},{...owner,emailVerified:false}),false);
});
