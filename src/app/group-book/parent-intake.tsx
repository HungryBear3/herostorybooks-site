'use client';

import { useState } from 'react';
import { Icon, WatercolorCrest, Wordmark } from '@/components/family-review/atoms';

type Phase = 'gate' | 'form' | 'submitting';

const AGE_RANGES = ['2-3', '3-4', '5-6', '7-8', '9-10', '10+'] as const;
const PHOTO_UPLOAD_MAX_DIMENSION = 1600;

async function decodePhoto(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try {
      return await window.createImageBitmap(file);
    } catch {
      // Safari/mobile fall through to HTMLImageElement decoding.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function preparePhoto(file: File): Promise<Blob> {
  if (file.size <= 1_500_000 && ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.type)) {
    return file;
  }
  const image = await decodePhoto(file);
  const scale = Math.min(1, PHOTO_UPLOAD_MAX_DIMENSION / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext('2d');
  if (!context) return file;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return await new Promise<Blob>((resolve) => {
    canvas.toBlob((blob) => resolve(blob ?? file), 'image/jpeg', 0.82);
  });
}

export default function GroupBookPortal() {
  const [phase, setPhase] = useState<Phase>('gate');
  const [invite, setInvite] = useState('');
  const [parentName, setParentName] = useState('');
  const [parentEmail, setParentEmail] = useState('');
  const [childFirstName, setChildFirstName] = useState('');
  const [ageRange, setAgeRange] = useState('');
  const [characterNotes, setCharacterNotes] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [guardian, setGuardian] = useState(false);
  const [sharedBook, setSharedBook] = useState(false);
  const [schoolDisclaimer, setSchoolDisclaimer] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function continueFromGate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const response = await fetch('/api/group-book/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invite }),
    });
    const body = await response.json().catch(() => ({})) as { accessUrl?: string; error?: string };
    if (response.ok && body.accessUrl) {
      window.location.assign(body.accessUrl);
      return;
    }
    if (response.status === 404 && body.error === 'not_submitted') {
      setPhase('form');
      return;
    }
    setError(
      response.status === 503
        ? 'Private group-book intake is not enabled in this environment.'
        : 'That private family invite was not recognized.',
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPhase('submitting');
    const form = new FormData();
    form.set('invite', invite);
    form.set('parentName', parentName);
    form.set('parentEmail', parentEmail);
    form.set('childFirstName', childFirstName);
    form.set('ageRange', ageRange);
    form.set('characterNotes', characterNotes);
    form.set('guardianAuthority', guardian ? 'true' : 'false');
    form.set('sharedWithParticipatingFamilies', sharedBook ? 'true' : 'false');
    form.set('sourcePhotosRemainPrivate', sharedBook ? 'true' : 'false');
    form.set('schoolApprovalNotRepresentedOrImplied', schoolDisclaimer ? 'true' : 'false');
    try {
      for (const file of files) {
        form.append('photos', await preparePhoto(file), 'reference-photo.jpg');
      }
    } catch {
      setPhase('form');
      setError('One of the photos could not be prepared. Try a JPG, PNG, WEBP, or HEIC image.');
      return;
    }
    const response = await fetch('/api/group-book/intake', { method: 'POST', body: form });
    const body = await response.json().catch(() => ({})) as { accessUrl?: string; error?: string };
    if (response.ok && body.accessUrl) {
      setFiles([]);
      window.location.assign(body.accessUrl);
      return;
    }
    setPhase('form');
    setError(
      body.error === 'invalid_invite'
        ? 'That private family invite was not recognized.'
        : body.error === 'storage_disabled'
          ? 'Private group-book intake is not enabled in this environment.'
          : 'The submission was not saved. Please review the fields and try again.',
    );
  }

  const ready = guardian && sharedBook && schoolDisclaimer && files.length >= 1 && files.length <= 5;

  return (
    <>
      <header className="topbar">
        <Wordmark size={14} />
        <span className="meta">private group book · one family at a time</span>
      </header>
      <main className="fr-container">
        {phase === 'gate' ? (
          <section className="stack-24" style={{ paddingTop: 40 }}>
            <div style={{ textAlign: 'center' }}><WatercolorCrest /></div>
            <div className="stack-8" style={{ textAlign: 'center' }}>
              <div className="eyebrow ochre">Private family invite</div>
              <h1 className="fr-h1 serif">Add only your own child to the group book.</h1>
              <p className="body">
                Each participating family has a separate invite and private access. Room parents
                cannot see submissions, and there is no public gallery.
              </p>
            </div>
            <form className="card card-warm stack-12" style={{ padding: 18 }} onSubmit={continueFromGate}>
              <label className="field">
                <span className="field-label">Your private family invite</span>
                <input className="input" value={invite} onChange={(e) => setInvite(e.target.value)} autoComplete="off" />
              </label>
              {error && <p className="help" style={{ color: 'var(--err)' }}>{error}</p>}
              <button className="btn btn-forest btn-block btn-lg" type="submit" disabled={!invite.trim()}>
                Continue <Icon name="arrow-right" size={16} color="#f7f1e3" />
              </button>
            </form>
          </section>
        ) : (
          <form className="stack-20" style={{ paddingTop: 16, paddingBottom: 48 }} onSubmit={submit}>
            <div className="stack-6">
              <div className="eyebrow forest">Your child only</div>
              <h1 className="fr-h1 serif">Private group-book intake</h1>
              <p className="body">Do not enter another family&apos;s child or forward your invite.</p>
            </div>

            <section className="card stack-12" style={{ padding: 18 }}>
              <h2 className="fr-h3 serif">Parent or legal guardian</h2>
              <label className="field"><span className="field-label">Your name</span><input className="input" value={parentName} onChange={(e) => setParentName(e.target.value)} required maxLength={80} /></label>
              <label className="field"><span className="field-label">Your email</span><input className="input" type="email" value={parentEmail} onChange={(e) => setParentEmail(e.target.value)} required maxLength={200} /></label>
            </section>

            <section className="card stack-12" style={{ padding: 18 }}>
              <h2 className="fr-h3 serif">Your child</h2>
              <label className="field"><span className="field-label">First name only</span><input className="input" value={childFirstName} onChange={(e) => setChildFirstName(e.target.value)} required maxLength={40} /></label>
              <label className="field"><span className="field-label">Age range</span><select className="input" value={ageRange} onChange={(e) => setAgeRange(e.target.value)} required><option value="">Choose one</option>{AGE_RANGES.map((age) => <option key={age} value={age}>{age}</option>)}</select></label>
              <label className="field"><span className="field-label">Appearance or character notes <span className="opt">optional</span></span><textarea className="input" rows={4} value={characterNotes} onChange={(e) => setCharacterNotes(e.target.value)} maxLength={600} placeholder="Details that help us represent your child accurately." /></label>
              <label className="field">
                <span className="field-label">1–5 private reference photos</span>
                <input className="input" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 5))} required />
                <span className="help">{files.length ? `${files.length} photo${files.length === 1 ? '' : 's'} selected` : 'Original filenames are discarded. Source photos are never shown to participating families.'}</span>
              </label>
            </section>

            <section className="card card-warm stack-12" style={{ padding: 18 }}>
              <div className="eyebrow forest">Explicit group-book consent</div>
              <label className="fr-row" style={{ alignItems: 'flex-start' }}><input type="checkbox" checked={guardian} onChange={(e) => setGuardian(e.target.checked)} /><span className="help"><strong>I am this child&apos;s parent or legal guardian</strong> and I am submitting only my own child&apos;s details and photos.</span></label>
              <label className="fr-row" style={{ alignItems: 'flex-start' }}><input type="checkbox" checked={sharedBook} onChange={(e) => setSharedBook(e.target.checked)} /><span className="help"><strong>I agree that my child&apos;s first name and illustrated likeness may appear in this private group book shared with participating families.</strong> Source photos stay private to authorized HeroStoryBooks operators and are not placed in a family gallery.</span></label>
              <label className="fr-row" style={{ alignItems: 'flex-start' }}><input type="checkbox" checked={schoolDisclaimer} onChange={(e) => setSchoolDisclaimer(e.target.checked)} /><span className="help"><strong>I understand this parent-run group book does not represent or imply school, teacher, district, or administrator approval.</strong></span></label>
              <p className="help">Before proof or print, you can use your private family access to withdraw your child. A withdrawal marks the child for omission from proof and print.</p>
            </section>

            {error && <p className="help" style={{ color: 'var(--err)' }}>{error}</p>}
            <button className="btn btn-forest btn-block btn-lg" type="submit" disabled={!ready || phase === 'submitting'}>
              {phase === 'submitting' ? 'Saving privately…' : 'Submit my child privately'}
            </button>
            <p className="help" style={{ textAlign: 'center' }}>No payment, customer email, automated generation, provider, proof, print, or distribution action occurs on submit.</p>
          </form>
        )}
      </main>
    </>
  );
}
