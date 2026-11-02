import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleClassroomAuth} from '../src/lib/group-book/auth-handler.ts';

const config={enabled:true,publishableKey:'sb_publishable_synthetic',secure:true};
const ORIGIN='https://hsb.example.test';
const NOW=Date.UTC(2026,10,2,12,0,0,0);
const FUTURE='2026-11-03T12:00:00.000Z';
const A='adult-a@example.invalid';
const B='adult-b@example.invalid';
const ENV_KEYS=['VERCEL_ENV','HSB_CLASSROOM_PREVIEW_RECIPIENTS_JSON'] as const;
type EnvKey=typeof ENV_KEYS[number];
const allow=(emails:unknown=[A,B],expiresAt:unknown=FUTURE)=>JSON.stringify({emails,expiresAt});
const req=(body:unknown,origin=ORIGIN,type='application/json')=>new Request(`${ORIGIN}/group-book/auth`,{method:'POST',headers:{Origin:origin,'Content-Type':type},body:JSON.stringify(body)});
const requestBody=(email:unknown)=>({action:'request',email});
const verifyBody=(email:unknown)=>({action:'verify',email,code:'12345678'});

async function withEnv(env:Partial<Record<EnvKey,string|undefined>>,fn:()=>Promise<void>,now=NOW){
 const saved=ENV_KEYS.map(k=>[k,process.env[k]] as const);
 const realNow=Date.now;
 for(const k of ENV_KEYS){const v=env[k]; if(v===undefined) delete process.env[k]; else process.env[k]=v;}
 Date.now=()=>now;
 try{await fn();}
 finally{Date.now=realNow; for(const [k,v] of saved){if(v===undefined) delete process.env[k]; else process.env[k]=v;}}
}

function provider(){
 const calls:{path:string;body:Record<string,unknown>|undefined}[]=[];
 const fetcher:typeof fetch=async(input,init)=>{
  const path=new URL(String(input)).pathname.replace('/auth/v1','');
  calls.push({path,body:init?.body?JSON.parse(String(init.body)):undefined});
  if(path==='/otp') return new Response('{}');
  if(path==='/verify') return new Response(JSON.stringify({access_token:'synthetic-access',refresh_token:'must-not-escape',expires_in:3600}));
  if(path==='/user') return new Response(JSON.stringify({id:'11111111-2222-4333-8444-555555555555',email_confirmed_at:'2026-10-23T00:00:00Z',is_anonymous:false}));
  return new Response('{}',{status:404});
 };
 return {calls,fetcher};
}

async function assertDenied(label:string,email:unknown=A){
 const p=provider();
 for(const body of [requestBody(email),verifyBody(email)]){
  const r=await handleClassroomAuth(req(body),config,p.fetcher);
  assert.equal(r.status,503,label);
  assert.deepEqual(await r.json(),{ok:false,error:'auth_unavailable'},label);
  assert.equal(r.headers.get('set-cookie'),null,label);
 }
 assert.equal(p.calls.length,0,label);
}

// Pattern-like entries are paired with valid A: zero provider calls for A proves the whole config is rejected.
const badConfigs:[string,string|undefined][]=[
 ['missing',undefined],
 ['empty',''],
 ['whitespace','   '],
 ['malformed json','{"emails":['],
 ['unquoted keys','{emails:[]}'],
 ['null','null'],
 ['array',JSON.stringify([A])],
 ['string',JSON.stringify(A)],
 ['empty object','{}'],
 ['empty list',allow([])],
 ['emails not array',allow(A)],
 ['non-string entry',allow([A,7])],
 ['empty entry',allow([A,''])],
 ['too many',allow([A,B,'adult-c@example.invalid'])],
 ['extra field',JSON.stringify({emails:[A],expiresAt:FUTURE,owner:'x'})],
 ['missing expiry',JSON.stringify({emails:[A]})],
 ['overlong entry',allow([A,'a'.repeat(250)+'@example.invalid'])],
 ['overlong document',allow([A])+' '.repeat(1100)],
 ['past expiry',allow([A],'2026-11-01T12:00:00.000Z')],
 ['equal expiry',allow([A],'2026-11-02T12:00:00.000Z')],
 ['unparseable expiry',allow([A],'tomorrow')],
 ['numeric expiry',allow([A],NOW+86400000)],
 ['date only',allow([A],'2026-11-03')],
 ['no zone',allow([A],'2026-11-03T12:00:00')],
 ['offset zone',allow([A],'2026-11-03T12:00:00+00:00')],
 ['lowercase z',allow([A],'2026-11-03T12:00:00z')],
 ['microseconds',allow([A],'2026-11-03T12:00:00.000000Z')],
 ['rollover feb 29',allow([A],'2027-02-29T00:00:00Z')],
 ['rollover nov 31',allow([A],'2026-11-31T00:00:00Z')],
 ['rollover month 13',allow([A],'2026-13-01T00:00:00Z')],
 ['rollover hour 24',allow([A],'2026-11-03T24:00:00Z')],
 ['rollover minute 60',allow([A],'2026-11-03T12:60:00Z')],
 ['wildcard entry before A',allow(['*@example.invalid',A])],
 ['wildcard entry after A',allow([A,'*@example.invalid'])],
 ['partial wildcard',allow([A,'adult-*@example.invalid'])],
 ['regex anchored entry',allow([A,'^adult-a@example[.]invalid$'])],
 ['regex meta entry',allow([A,'adult-(a|b)@example\\.invalid'])],
 ['domain entry',allow([A,'@example.invalid'])],
 ['bare domain',allow([A,'example.invalid'])],
];

test('preview: missing, empty, malformed, out-of-bounds, pattern or expired allowlist denies before provider',async()=>{
 for(const [label,value] of badConfigs) await withEnv({VERCEL_ENV:'preview',HSB_CLASSROOM_PREVIEW_RECIPIENTS_JSON:value},()=>assertDenied(label));
 await withEnv({VERCEL_ENV:'preview',HSB_CLASSROOM_PREVIEW_RECIPIENTS_JSON:allow([A,'*@example.invalid'])},()=>assertDenied('literal wildcard','*@example.invalid'));
});

test('preview: unapproved, alias, suffix, partial and pattern addresses are denied before provider',async()=>{
 const emails=['adult-c@example.invalid','adult-a+qa@example.invalid','adult-b+1@example.invalid','a.dult-a@example.invalid','adult-b.@example.invalid','adulta@example.invalid',
  'adult-a@example.invalid.evil.test','xadult-a@example.invalid','adult-a@sub.example.invalid','adult-a@example.invali','dult-a@example.invalid',
  '*@example.invalid','.*@example.invalid','adult-.@example.invalid','adult-a@example.invalid,adult-c@example.invalid','adult-a@example.invalid adult-c@example.invalid','not-an-email'];
 await withEnv({VERCEL_ENV:'preview',HSB_CLASSROOM_PREVIEW_RECIPIENTS_JSON:allow()},async()=>{for(const e of emails) await assertDenied(e,e);});
});

test('preview: each configured recipient passes request and verify after trim/lowercase with normalized provider bodies',async()=>{
 const cases:[string,string,string][]=[
  [A,'  ADULT-A@Example.Invalid ',' adult-a@EXAMPLE.invalid'],
  [B,'\tAdult-B@example.INVALID ','ADULT-B@EXAMPLE.INVALID  '],
 ];
 await withEnv({VERCEL_ENV:'preview',HSB_CLASSROOM_PREVIEW_RECIPIENTS_JSON:allow([' Adult-A@EXAMPLE.invalid ',' ADULT-b@Example.INVALID'],'2026-11-03T12:00:00Z')},async()=>{
  for(const [normalized,requestInput,verifyInput] of cases){
   const p=provider();
   const r1=await handleClassroomAuth(req(requestBody(requestInput)),config,p.fetcher);
   assert.equal(r1.status,200,normalized); assert.deepEqual(await r1.json(),{ok:true},normalized);
   const r2=await handleClassroomAuth(req(verifyBody(verifyInput)),config,p.fetcher);
   assert.equal(r2.status,200,normalized); assert.deepEqual(await r2.json(),{ok:true},normalized);
   const cookie=r2.headers.get('set-cookie')!;
   assert.ok(cookie.includes('hsb_classroom_auth=synthetic-access'),normalized); assert.ok(!cookie.includes('must-not-escape'),normalized);
   assert.deepEqual(p.calls.map(c=>c.path),['/otp','/verify','/user'],normalized);
   assert.equal(p.calls[0].body!.email,normalized); assert.equal(p.calls[1].body!.email,normalized);
  }
 });
});

test('preview: expiry is evaluated at runtime on every action',async()=>{
 const expiry=Date.parse(FUTURE);
 const env={VERCEL_ENV:'preview',HSB_CLASSROOM_PREVIEW_RECIPIENTS_JSON:allow([A],FUTURE)};
 await withEnv(env,async()=>{
  const p=provider();
  assert.equal((await handleClassroomAuth(req(requestBody(A)),config,p.fetcher)).status,200);
  assert.equal((await handleClassroomAuth(req(verifyBody(A)),config,p.fetcher)).status,200);
  assert.equal(p.calls.length,3);
 },expiry-1);
 await withEnv(env,()=>assertDenied('at expiry'),expiry);
 await withEnv(env,()=>assertDenied('after expiry'),expiry+1);
});

test('preview: origin, content type, disabled auth and malformed input still stop before provider for both actions',async()=>{
 await withEnv({VERCEL_ENV:'preview',HSB_CLASSROOM_PREVIEW_RECIPIENTS_JSON:allow()},async()=>{
  const p=provider();
  for(const body of [requestBody(A),verifyBody(A)]){
   const label=String(body.action);
   const origin=await handleClassroomAuth(req(body,'https://evil.test'),config,p.fetcher);
   assert.equal(origin.status,403,label); assert.equal((await origin.json()).error,'invalid_origin',label);
   assert.equal((await handleClassroomAuth(req(body,ORIGIN,'text/plain'),config,p.fetcher)).status,400,label);
   const off=await handleClassroomAuth(req(body),{...config,enabled:false},p.fetcher);
   assert.equal(off.status,503,label); assert.equal((await off.json()).error,'auth_not_configured',label);
   assert.equal((await handleClassroomAuth(req({...body,email:7}),config,p.fetcher)).status,400,label);
  }
  assert.equal((await handleClassroomAuth(req({action:'other',email:A}),config,p.fetcher)).status,400);
  assert.equal(p.calls.length,0);
 });
});

test('preview signout still clears cookies without allowlist or provider',async()=>{
 await withEnv({VERCEL_ENV:'preview'},async()=>{
  const p=provider();
  const r=await handleClassroomAuth(req({action:'signout'}),{...config,enabled:false},p.fetcher);
  assert.equal(r.status,200); assert.deepEqual(await r.json(),{ok:true});
  const cookies=r.headers.getSetCookie();
  assert.equal(cookies.length,2);
  assert.ok(cookies.every(c=>c.includes('Max-Age=0')&&c.includes('Secure')&&c.includes('HttpOnly')));
  assert.equal(p.calls.length,0);
 });
});

test('non-preview behavior unchanged: no allowlist needed, email forwarded verbatim',async()=>{
 for(const env of [undefined,'production','development']) for(const list of [undefined,'not-json',allow([A])]) {
  await withEnv({VERCEL_ENV:env,HSB_CLASSROOM_PREVIEW_RECIPIENTS_JSON:list},async()=>{
   const p=provider();
   const r=await handleClassroomAuth(req(requestBody('P@Example.test')),config,p.fetcher);
   assert.equal(r.status,200); assert.deepEqual(await r.json(),{ok:true});
   const v=await handleClassroomAuth(req(verifyBody('P@Example.test')),config,p.fetcher);
   assert.equal(v.status,200); assert.ok(v.headers.get('set-cookie')!.includes('hsb_classroom_auth=synthetic-access'));
   assert.deepEqual(p.calls.map(c=>c.path),['/otp','/verify','/user']);
   assert.equal(p.calls[0].body!.email,'P@Example.test'); assert.equal(p.calls[1].body!.email,'P@Example.test');
  });
 }
});

test('non-preview: invalid_email on request and verify makes no provider calls',async()=>{
 for(const env of [undefined,'production','development']) {
  await withEnv({VERCEL_ENV:env},async()=>{
   const p=provider();
   for(const body of [requestBody(' p@example.test'),verifyBody(' p@example.test')]){
    const r=await handleClassroomAuth(req(body),config,p.fetcher);
    assert.equal(r.status,400,String(body.action));
    assert.deepEqual(await r.json(),{ok:false,error:'invalid_email'},String(body.action));
    assert.equal(r.headers.get('set-cookie'),null,String(body.action));
   }
   assert.equal(p.calls.length,0);
  });
 }
});
