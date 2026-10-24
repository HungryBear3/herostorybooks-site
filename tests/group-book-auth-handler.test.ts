import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleClassroomAuth} from '../src/lib/group-book/auth-handler.ts';
const config={enabled:true,publishableKey:'sb_publishable_synthetic',secure:true};
const request=(body:unknown,origin='https://hsb.example.test')=>new Request('https://hsb.example.test/group-book/auth',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
test('disabled and cross-origin requests never reach provider',async()=>{
 let calls=0; const fetcher:typeof fetch=async()=>{calls++;throw Error('must not call')};
 assert.equal((await handleClassroomAuth(request({action:'request',email:'p@example.test'}),{...config,enabled:false},fetcher)).status,503);
 assert.equal((await handleClassroomAuth(request({action:'request',email:'p@example.test'},'https://evil.test'),config,fetcher)).status,403);
 assert.equal(calls,0);
});
test('framework internal localhost URL uses incoming Host for same-origin check',async()=>{
 const req=new Request('http://localhost:3197/group-book/auth',{method:'POST',headers:{Host:'127.0.0.1:3197',Origin:'http://127.0.0.1:3197','Content-Type':'application/json'},body:'{}'});
 assert.equal((await handleClassroomAuth(req,{...config,enabled:false})).status,503);
});
test('verified session is HttpOnly cookie, never JSON; no refresh token retained',async()=>{
 const replies=[{access_token:'synthetic-access',refresh_token:'must-not-escape',expires_in:3600},{id:'11111111-2222-4333-8444-555555555555',email_confirmed_at:'2026-10-23',is_anonymous:false}];
 const fetcher:typeof fetch=async()=>new Response(JSON.stringify(replies.shift()));
 const response=await handleClassroomAuth(request({action:'verify',email:'p@example.test',code:'12345678'}),config,fetcher);
 assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{ok:true});
 const cookie=response.headers.get('set-cookie')!;
 for(const part of ['HttpOnly','Secure','SameSite=Strict','Path=/group-book','Max-Age=3600']) assert.ok(cookie.includes(part));
 assert.ok(!cookie.includes('must-not-escape'));
 assert.equal(response.headers.get('cache-control'),'no-store, private');
});
test('malformed actions and failed provider verification do not set cookies',async()=>{
 const fetcher:typeof fetch=async()=>new Response('{}',{status:401});
 for(const body of [null,{}, {action:'verify',email:'p@example.test',code:'12345678'}]) {
  const response=await handleClassroomAuth(request(body),config,fetcher);
  assert.ok(response.status>=400);
  assert.equal(response.headers.get('set-cookie'),null);
 }
});
test('request acknowledges only provider success and sanitizes failures',async()=>{
 const ok:typeof fetch=async()=>new Response('{}');
 const result=await handleClassroomAuth(request({action:'request',email:'p@example.test'}),config,ok);
 assert.deepEqual(await result.json(),{ok:true});
 const failed:typeof fetch=async()=>{throw Error('secret detail')};
 const response=await handleClassroomAuth(request({action:'request',email:'p@example.test'}),config,failed);
 assert.equal(response.status,503);assert.equal((await response.json()).error,'auth_unavailable');
});
