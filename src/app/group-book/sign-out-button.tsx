'use client';
import {useState} from 'react';
export default function SignOutButton(){
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  async function signOut(){
    if(busy)return;
    setBusy(true);setMessage('');
    try {
      const response=await fetch('/group-book/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'signout'})});
      if(!response.ok)throw new Error();
      window.location.assign('/group-book/sign-in');
    }catch{setMessage('Sign-out could not be confirmed. Please try again.');}
    finally{setBusy(false);}
  }
  return <div><button type="button" disabled={busy} onClick={signOut}>Sign out of this browser</button><p role="status">{message}</p></div>;
}
