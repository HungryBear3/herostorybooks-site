// Actual component SSR + callback execution; synthetic transport, NOT provider/browser E2E.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const file=new URL('../src/app/group-book/sign-in/sign-in-form.tsx',import.meta.url);
function source(){return readFileSync(file,'utf8');}
test('actual sign-in component renders a truthful unavailable state, not hidden page',()=>{
 const exports:Record<string,unknown>={};
 const code=ts.transpileModule(source(),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{exports,require:createRequire(import.meta.url)});
 const html=renderToStaticMarkup(React.createElement(exports.default as React.ComponentType<{enabled:boolean}>,{enabled:false}));
 assert.match(html,/Classroom email sign-in/);assert.match(html,/not available yet/);assert.match(html,/\/group-book/);
 assert.doesNotMatch(html,/<form/);
 const ready=renderToStaticMarkup(React.createElement(exports.default as React.ComponentType<{enabled:boolean}>,{enabled:true}));
 assert.match(ready,/type="email"/);assert.match(ready,/Send sign-in code/);assert.match(ready,/I already have a code/);
 const entry=readFileSync(new URL('../src/app/group-book/page.tsx',import.meta.url),'utf8');
 assert.match(entry,/href="\/group-book\/sign-in"/);
});
test('actual submit callback clears busy state on failed or malformed response without claiming success',async()=>{
 const ast=ts.createSourceFile('form.tsx',source(),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let found:ts.FunctionDeclaration|undefined;function visit(n:ts.Node){if(ts.isFunctionDeclaration(n)&&n.name?.text==='submit')found=n;ts.forEachChild(n,visit);}visit(ast);assert.ok(found);
 const code=ts.transpileModule(found.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 for(const kind of ['network','json','null']){
  const state={busy:false,message:'',phase:'email'};
  const submit=vm.runInNewContext(`${code};submit`,{enabled:true,lock:{current:false},phase:'email',email:'p@example.test',code:'',setBusy:(v:boolean)=>state.busy=v,setMessage:(v:string)=>state.message=v,setPhase:(v:string)=>state.phase=v,fetch:async()=>{if(kind==='network')throw Error();return {ok:true,json:async()=>{if(kind==='json')throw Error();return null;}};}});
  await submit({preventDefault(){}});
  assert.equal(state.busy,false);assert.equal(state.phase,'email');assert.match(state.message,/could not confirm/i);
 }
});
