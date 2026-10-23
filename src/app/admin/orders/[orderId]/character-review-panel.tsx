'use client';
import { useEffect, useState } from 'react';
type Review = { version: string; status: string; workQueue: Array<{ id: string; kind: string; status: string; comment?: string }> };
export default function CharacterReviewPanel({ orderId }: { orderId: string }) {
 const [review, setReview] = useState<Review | null>(null); const [loaded, setLoaded] = useState(false);
 const [hash, setHash] = useState(''); const [description, setDescription] = useState(''); const [qa, setQa] = useState(false);
 const [message, setMessage] = useState(''); const [link, setLink] = useState(''); const [busy, setBusy] = useState(false);
 const endpoint = `/api/admin/orders/${encodeURIComponent(orderId)}/character-review`;
 async function load() { const r = await fetch(endpoint, { cache: 'no-store' }); if (!r.ok) throw Error('Character review unavailable.'); setReview((await r.json()).review); setLoaded(true); }
 useEffect(() => { load().catch(e => setMessage(e.message)); }, [endpoint]);
 async function publish() {
  setBusy(true); setLink('');
  try {
   const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: review?.version ?? null, imageHash: hash.trim(), description, attestation: qa ? 'reviewed_exact_character_sheet' : '' }) });
   const data = await r.json(); if (!r.ok) throw Error(data.error ?? 'Unable to prepare review.');
   setLink(`${window.location.origin}${data.reviewPath}`); setMessage('Private link prepared; not sent. Previous invitation is revoked.'); setQa(false); await load();
  } catch(e) { setMessage(e instanceof Error ? e.message : 'Unable to prepare review.'); } finally { setBusy(false); }
 }
 return <section className="rounded border bg-white p-5 space-y-3"><h2 className="text-xl font-bold">Character review</h2>
  <p>{review ? `Current status: ${review.status}` : 'No customer character review prepared.'}</p>
  <ul>{review?.workQueue.map(e => <li key={e.id}>{e.kind} — {e.status}{e.comment ? `: ${e.comment}` : ''}</li>)}</ul>
  <p>Pending items are durable work records, not confirmation that an agent has started. Only the current approved version may be used for the book.</p>
  <label className="block">Staged private PNG SHA-256<input className="block border w-full" value={hash} onChange={e => setHash(e.target.value)} /></label>
  <label className="block">Customer-facing character description<textarea className="block border w-full" maxLength={4000} value={description} onChange={e => setDescription(e.target.value)} /></label>
  <label className="block"><input type="checkbox" checked={qa} onChange={e => setQa(e.target.checked)} /> I reviewed this exact staged character sheet and description.</label>
  <button disabled={!loaded || busy || !qa || !/^[a-f0-9]{64}$/.test(hash.trim()) || !description.trim()} onClick={publish} className="border rounded p-2">Prepare private character review</button>
  {link && <p className="break-all">Private invitation (not sent): <a href={link}>{link}</a></p>}
  <p role="status">{message}</p>
 </section>;
}
