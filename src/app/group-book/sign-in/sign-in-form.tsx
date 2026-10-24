'use client';
import {useRef, useState, type FormEvent} from 'react';

export default function ClassroomSignIn({enabled}:{enabled:boolean}) {
  const [email,setEmail]=useState('');
  const [code,setCode]=useState('');
  const [phase,setPhase]=useState<'email'|'code'|'verified'>('email');
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const lock=useRef(false);
  async function submit(event:FormEvent) {
    event.preventDefault();
    if(!enabled || lock.current || phase==='verified') return;
    lock.current=true;setBusy(true);setMessage('');
    try {
      const response=await fetch('/group-book/auth',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({action:phase==='email'?'request':'verify',email, ...(phase==='code'?{code}:{})})});
      const result:unknown=await response.json();
      if(!response.ok || !result || typeof result!=='object' || (result as {ok?:unknown}).ok!==true) throw Error('unconfirmed');
      setPhase(phase==='email'?'code':'verified');
      setMessage(phase==='email'?'Check your email for an eight-digit code.':'Email verified. Classroom enrollment is not completed by signing in.');
    } catch {setMessage('We could not confirm this request. If a code arrived, use it; otherwise wait before trying again.');}
    finally {lock.current=false;setBusy(false);}
  }
  return <main className="mx-auto max-w-lg space-y-6 px-6 py-12">
    <h1 className="text-2xl font-semibold">Classroom email sign-in</h1>
    <p>Verify your own email with a one-time code. A classroom code alone does not grant access to another family’s information.</p>
    {!enabled ? <p role="status">Email sign-in is not available yet. Existing family access remains available below.</p> : phase!=='verified' ?
      <form onSubmit={submit} className="space-y-4">
        <label className="block">Your email<input className="block w-full rounded border p-3" type="email" autoComplete="email" required maxLength={254} value={email} disabled={busy || phase==='code'} onChange={e=>setEmail(e.target.value)}/></label>
        {phase==='code' && <label className="block">Eight-digit sign-in code<input className="block w-full rounded border p-3" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{8}" minLength={8} maxLength={8} required value={code} disabled={busy} onChange={e=>setCode(e.target.value)}/></label>}
        <button className="rounded bg-slate-900 px-4 py-3 text-white disabled:opacity-50" disabled={busy} type="submit">{busy?'Please wait…':phase==='email'?'Send sign-in code':'Verify code'}</button>
        {phase==='email' && <button className="block underline" type="button" disabled={busy || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)} onClick={()=>{setPhase('code');setMessage('Enter the eight-digit code sent to this email.');}}>I already have a code</button>}
        {phase==='code' && <button className="block underline" type="button" disabled={busy} onClick={()=>{setPhase('email');setCode('');setMessage('');}}>Change email or request another code</button>}
      </form> : null}
    <p role="status" aria-live="polite">{message}</p>
    <a className="block underline" href="/group-book">Enter your classroom code or return to family access</a>
  </main>;
}
