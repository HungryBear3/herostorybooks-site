'use client';
import { useEffect, useRef, useState } from 'react';
type Sheet = { version: string; description: string; status: string; comment?: string };
const labels: Record<string, string> = { awaiting_customer: 'Waiting for your decision', approved: 'Approved', changes_requested: 'Changes requested' };
const scope = "This approves how your character looks. You'll review the finished book separately before anything prints.";
const imageError = "The character image didn't load. Please reopen your invitation link to try again.";
export default function CharacterReviewClient({ orderId }: { orderId: string }) {
  const token = useRef(''); const dialog = useRef<HTMLDialogElement>(null); const notice = useRef<HTMLParagraphElement>(null);
  const saving = useRef(false);
  const [sheet, setSheet] = useState<Sheet>(); const [image, setImage] = useState(''); const [imageReady, setImageReady] = useState(false);
  const [comment, setComment] = useState(''); const [message, setMessage] = useState('Loading your character…');
  const [error, setError] = useState(false); const [busy, setBusy] = useState<'approve' | 'request_changes' | null>(null);
  const endpoint = `/api/order/${encodeURIComponent(orderId)}/character-review`;
  useEffect(() => {
    token.current = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? token.current;
    window.history.replaceState(null, '', window.location.pathname);
    let active = true; let imageUrl = '';
    if (!token.current) {
      setError(true); setMessage('Please open this page from your latest invitation link. If you refreshed the page, open that link again.');
      return;
    }
    (async () => {
      const headers = { Authorization: `Bearer ${token.current}` };
      const response = await fetch(endpoint, { headers, cache: 'no-store' });
      if (!response.ok) throw Error('This review link is unavailable. Please open your latest invitation link.');
      const data = await response.json();
      const picture = await fetch(`${endpoint}?asset=image&version=${encodeURIComponent(data.version)}`, { headers, cache: 'no-store' });
      if (!picture.ok) throw Error(imageError);
      imageUrl = URL.createObjectURL(await picture.blob());
      if (active) { setSheet(data); setImage(imageUrl); setMessage(''); } else URL.revokeObjectURL(imageUrl);
    })().catch(() => { if (active) { setError(true); setMessage('This review or its image is unavailable. Please open your latest invitation link.'); } });
    return () => { active = false; if (imageUrl) URL.revokeObjectURL(imageUrl); };
  }, [endpoint]);
  async function decide(action: 'approve' | 'request_changes') {
    if (!sheet || saving.current || !imageReady || sheet.status !== 'awaiting_customer') return;
    saving.current = true; setBusy(action); setError(false);
    try {
      const result = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.current}` },
        body: JSON.stringify({ version: sheet.version, action, comment: action === 'approve' ? '' : comment }) });
      if (!result.ok) throw Error(result.status === 409 ? 'This character has been updated or already has a decision. Please open your latest invitation link.' : "We couldn't save your response. Please check your connection and try again.");
      const data = await result.json(); setSheet({ ...sheet, status: data.status, comment: typeof data.comment === 'string' ? data.comment : undefined });
      setMessage(action === 'approve' ? `Character approved. ${scope}` : 'Your changes are saved for our team to review.');
    } catch (error) { setError(true); setMessage(error instanceof Error ? error.message : "We couldn't save your response. Please try again."); }
    finally { saving.current = false; setBusy(null); dialog.current?.close(); requestAnimationFrame(() => notice.current?.focus()); }
  }
  return <main className="mx-auto max-w-2xl p-6 space-y-5" aria-busy={!!busy}>
    <h1 className="text-3xl font-bold">Meet your storybook character</h1>
    <p>Take a look at your storybook character. Approve the appearance if it looks right, or tell us what to change.</p>
    {image && <img src={image} alt="Your proposed storybook character sheet" className="w-full max-h-[70vh] object-contain rounded-lg" onLoad={() => setImageReady(true)} onError={() => { setImageReady(false); setError(true); setMessage(imageError); }} />}
    {!image && !error && <div className="aspect-square rounded-lg bg-slate-100" aria-hidden="true" />}
    {sheet && <><h2 className="font-semibold">How we'll draw them</h2><p className="whitespace-pre-wrap">{sheet.description}</p><p>Status: {labels[sheet.status] ?? 'In review'}</p>
      <p>{scope}</p>
      {sheet.status === 'approved' && <p>Your approval is saved for this character design.</p>}
      {sheet.status === 'changes_requested' && <p>Your change request is saved for our team to review.</p>}
      {sheet.status === 'changes_requested' && sheet.comment && <section aria-label="Your saved notes"><h2 className="font-semibold">Your notes</h2><p className="whitespace-pre-wrap">{sheet.comment}</p></section>}
      {sheet.status === 'awaiting_customer' && <><label className="block" htmlFor="changes">What would you like changed?</label>
        <p id="changes-help">Mention details such as hair, eyes, glasses, clothing or pets.</p>
        <textarea id="changes" value={comment} maxLength={2000} disabled={!!busy} aria-describedby="changes-help changes-count changes-hint" onChange={e => setComment(e.target.value)} placeholder="For example: Her hair is curlier and shoulder-length." className="block w-full min-h-24 text-base border border-slate-500 rounded p-3" />
        <p id="changes-count">{comment.length} / 2000</p><p id="changes-hint">{!comment.trim() ? 'Add a note above to request changes.' : 'Your notes will be saved when you request changes.'}</p>
        <div className="flex flex-col sm:flex-row gap-4"><button disabled={!!busy || !imageReady} onClick={() => dialog.current?.showModal()} className="min-h-11 bg-blue-700 text-white rounded p-3">Approve this character</button>
        <button disabled={!!busy || !imageReady || !comment.trim()} onClick={() => decide('request_changes')} className="min-h-11 border border-slate-500 rounded p-3">{busy === 'request_changes' ? 'Sending…' : 'Request changes'}</button></div></>}
    </>}
    <p ref={notice} tabIndex={-1} role={error ? 'alert' : 'status'} aria-live={error ? 'assertive' : 'polite'}>{message}</p>
    <dialog ref={dialog} aria-labelledby="confirm-title" aria-describedby="confirm-scope" onCancel={event => { if (saving.current) event.preventDefault(); }} className="max-w-lg w-[calc(100%-2rem)] rounded-xl p-6 space-y-4 backdrop:bg-black/40">
      <h2 id="confirm-title" className="text-xl font-bold">Approve this character?</h2><p id="confirm-scope">{scope}</p>
      <div className="flex flex-col sm:flex-row gap-3"><button autoFocus disabled={!!busy} onClick={() => dialog.current?.close()} className="min-h-11 border border-slate-500 rounded p-3">Go back</button>
      <button disabled={!!busy || !imageReady} onClick={() => decide('approve')} className="min-h-11 bg-blue-700 text-white rounded p-3">{busy === 'approve' ? 'Approving…' : 'Yes, approve'}</button></div>
    </dialog>
  </main>;
}
