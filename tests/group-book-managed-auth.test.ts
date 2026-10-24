import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createManagedClassroomAuth, CLASSROOM_AUTH_URL } from '../src/lib/group-book/managed-auth.ts';

const key = 'sb_publishable_synthetic_test_only';
const user = { id: '11111111-2222-4333-8444-555555555555', email_confirmed_at: '2026-10-23T00:00:00Z', is_anonymous: false };
function transport(replies: unknown[]) {
  const calls: {url: string; init: RequestInit}[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({url: String(url), init: init!});
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next), {status: 200});
  };
  return { calls, fetcher };
}
test('managed OTP uses only pinned tenant and does not mint an application code', async () => {
  const t = transport([{}]);
  await createManagedClassroomAuth(key, t.fetcher).requestCode('parent@example.test');
  assert.equal(t.calls[0].url, `${CLASSROOM_AUTH_URL}/otp`);
  assert.deepEqual(JSON.parse(String(t.calls[0].init.body)), {email: 'parent@example.test', create_user: true});
  assert.equal(t.calls[0].init.redirect, 'error');
});
test('verification requires eight digits and validates session with provider user endpoint', async () => {
  const t = transport([{access_token: 'synthetic-token', expires_in: 3600}, user]);
  const auth = createManagedClassroomAuth(key, t.fetcher);
  await assert.rejects(auth.verifyCode('parent@example.test', '123456'));
  assert.equal(t.calls.length, 0);
  const result = await auth.verifyCode('parent@example.test', '12345678');
  assert.deepEqual(JSON.parse(String(t.calls[0].init.body)), {email:'parent@example.test',token:'12345678',type:'email'});
  assert.equal(t.calls[1].url, `${CLASSROOM_AUTH_URL}/user`);
  assert.equal(result.principal.issuer, CLASSROOM_AUTH_URL);
  assert.equal(result.principal.subject, user.id);
  assert.equal(result.principal.emailVerified, true);
  assert.equal(result.expiresIn, 3600);
});
test('unverified, anonymous, malformed and transport-failed identities fail closed', async () => {
  for (const response of [null, {}, {...user, email_confirmed_at: null}, {...user, is_anonymous:true}, {...user, id:'bad subject'}, new Error('sensitive upstream detail')]) {
    const t = transport([response]);
    assert.equal(await createManagedClassroomAuth(key,t.fetcher).principal('synthetic-token'), null);
  }
});
test('no bearer means no provider call; service keys and invalid input are rejected', async () => {
  const t = transport([]);
  assert.throws(()=>createManagedClassroomAuth('sb_secret_forbidden',t.fetcher));
  const auth=createManagedClassroomAuth(key,t.fetcher);
  assert.equal(await auth.principal(''),null);
  await assert.rejects(auth.requestCode('bad\nemail'));
  assert.equal(t.calls.length,0);
});
test('provider errors are sanitized; redirected and failed requests cannot authenticate',async()=>{
  const fetcher: typeof fetch=async()=>new Response('private upstream content',{status:429});
  await assert.rejects(createManagedClassroomAuth(key,fetcher).requestCode('parent@example.test'), {message:'auth_rate_limited'});
  assert.equal(await createManagedClassroomAuth(key,fetcher).principal('token'),null);
});
test('malformed successful verify payload never becomes a session',async()=>{
  for(const reply of [null,{}, {access_token:'token',expires_in:-1},{access_token:'token',expires_in:999999}]) {
    const t=transport([reply]);
    await assert.rejects(createManagedClassroomAuth(key,t.fetcher).verifyCode('parent@example.test','12345678'));
  }
});
