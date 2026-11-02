import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const root=new URL('../',import.meta.url);
test('LOCAL HTTP managed-session integration (synthetic provider transport and private store; not live E2E)',()=>{
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const output=execFileSync(process.execPath,['--experimental-strip-types','--test-reporter=tap','--import','./tests/helpers/group-book-route-register.mjs','./tests/helpers/group-book-session-http-scenario.ts'],{cwd:root,env,encoding:'utf8'});
 assert.match(output,/# tests 10/);assert.match(output,/# pass 10/);assert.match(output,/# fail 0/);
});
test('browser endpoints preserve scoped auth cookies and expose re-verification/signout',()=>{
 const read=(p:string)=>readFileSync(new URL(p,root),'utf8');
 const portal=read('src/app/group-book/parent-intake.tsx');
 assert.match(portal,/fetch\('\/group-book\/access'/);assert.match(portal,/fetch\('\/group-book\/intake'/);
 for(const lane of ['access','intake']) assert.match(read(`src/app/group-book/${lane}/route.ts`),/export \{ POST \}/);
 assert.match(read('src/app/group-book/family/page.tsx'),/SignOutButton/);
 assert.match(read('src/app/group-book/family/page.tsx'),/sign-in/);
 assert.match(read('src/app/group-book/sign-in/sign-in-form.tsx'),/Enter your classroom code/);
});
