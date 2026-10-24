'use client';

import { useState } from 'react';
import { Icon, WatercolorCrest, Wordmark } from '@/components/family-review/atoms';
import {
  GROUP_BOOK_ACCEPTED_PHOTO_TYPES,
  MAX_GROUP_BOOK_PHOTOS,
  MAX_PREPARED_PHOTO_BYTES,
  PREPARED_PHOTO_MAX_DIMENSION,
} from '@/lib/group-book/limits';

type Phase = 'gate' | 'form' | 'submitting';

/** Owner-adopted terms exactly as the server returned them; never defaulted here. */
interface PolicyView {
  version: string;
  digest: string;
  finishedBookRecipients: string;
  withdrawalCutoff: string;
  sourcePhotoRetention: string;
  depictedAdultPermission: string;
  guardianReviewScope: string;
  wholeBookApproval: string;
}

const POLICY_LABELS: [keyof PolicyView, string][] = [
  ['finishedBookRecipients', 'Who receives the finished book'],
  ['guardianReviewScope', 'What you can review'],
  ['wholeBookApproval', 'Whole-book approval'],
  ['depictedAdultPermission', 'Adults shown in photos'],
  ['withdrawalCutoff', 'Withdrawal'],
  ['sourcePhotoRetention', 'Source photo retention'],
];

function isPolicyView(value: unknown): value is PolicyView {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.version === 'string' && typeof row.digest === 'string' &&
    POLICY_LABELS.every(([key]) => typeof row[key] === 'string' && (row[key] as string).length > 0);
}

const AGE_RANGES = ['2-3', '3-4', '5-6', '7-8', '9-10', '10+'] as const;
const ENCODE_ATTEMPTS: [number, number][] = [[PREPARED_PHOTO_MAX_DIMENSION, 0.82], [1280, 0.75], [1024, 0.7]];

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

/**
 * Every photo is decoded and re-encoded in the browser as a canonical JPEG,
 * which drops location and other metadata before upload and bounds its size.
 * The original file is never uploaded. A photo that cannot be decoded or
 * fit under the prepared cap is refused here rather than sent.
 */
async function preparePhoto(file: File): Promise<Blob> {
  const image = await decodePhoto(file);
  for (const [maxDimension, quality] of ENCODE_ATTEMPTS) {
    const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas_unavailable');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) throw new Error('encode_failed');
    if (blob.size <= MAX_PREPARED_PHOTO_BYTES) return blob;
  }
  throw new Error('prepared_photo_too_large');
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
  const [checking, setChecking] = useState(false);
  const [policy, setPolicy] = useState<PolicyView | null>(null);
  // Operation-wide: once any save attempt had an unknown outcome, no later
  // attempt may claim "nothing saved", and no new intake POST is sent until
  // the server has been re-checked for this invite (recovery first).
  const [unresolvedSave, setUnresolvedSave] = useState(false);

  async function continueFromGate(e: React.FormEvent) {
    e.preventDefault();
    if (checking) return;
    setError(null);
    setChecking(true);
    try {
      const response = await fetch('/group-book/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invite }),
      });
      const body = await response.json() as { accessUrl?: string; error?: string };
      if (!body || typeof body !== 'object') throw new Error('Unconfirmed response');
      if (response.ok && body.accessUrl) {
        window.location.assign(body.accessUrl);
        return;
      }
      if (response.status === 404 && body.error === 'not_submitted') {
        const offered = (body as { policy?: unknown }).policy;
        if (!isPolicyView(offered)) throw new Error('Unconfirmed policy');
        // The server authoritatively found no saved submission for this invite.
        setUnresolvedSave(false);
        setPolicy(offered);
        setPhase('form');
        return;
      }
      setError(
        body.error === 'storage_disabled' || body.error === 'intake_closed' || body.error === 'policy_not_adopted'
          ? 'Family submissions are not open.'
          : body.error === 'storage_unavailable'
            ? 'Private storage could not be checked right now. Please try again later.'
            : body.error === 'invite_expired'
              ? 'This private family invite has expired.'
              : body.error === 'invite_revoked'
                ? 'This private family invite is no longer active.'
                : 'That code could not be opened. For classroom access, use Classroom email sign-in, then return and enter the code again. Private invites must still be valid.',
      );
    } catch {
      setError('Your invite could not be checked because the connection or response was interrupted. Please try again.');
    } finally {
      setChecking(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (phase === 'submitting' || !policy) return;
    if (unresolvedSave) {
      // Recovery first: an earlier attempt may have been saved. Send the
      // parent back to the invite check (invite kept) instead of re-posting.
      setPhase('gate');
      setError('An earlier attempt may have been saved. Press Continue to check your invite before submitting again.');
      return;
    }
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
    form.set('policyVersion', String(policy.version));
    form.set('policyDigest', policy.digest);
    try {
      for (const file of files) {
        form.append('photos', await preparePhoto(file), 'reference-photo.jpg');
      }
    } catch {
      setPhase('form');
      setError('One of the photos could not be prepared on this device. Nothing was sent. Try a different JPG, PNG, or WEBP photo.');
      return;
    }
    try {
      const response = await fetch('/group-book/intake', { method: 'POST', body: form });
      if (response.status === 413) {
        // Includes the platform's own non-JSON body-limit refusal: the request
        // was rejected before the handler ran, so nothing was written.
        setError('The photos were too large to send, so this attempt was not accepted. Try fewer or smaller photos.');
        return;
      }
      const body = await response.json() as { accessUrl?: string; error?: string };
      if (!body || typeof body !== 'object') throw new Error('Unconfirmed response');
      const definitive = ['invalid_invite', 'invite_expired', 'invite_revoked', 'storage_disabled', 'intake_closed',
        'policy_not_adopted', 'policy_consent_stale', 'unsupported_image', 'invalid_image', 'photo_too_large',
        'request_too_large', 'invalid_photo_count', 'missing_or_invalid_fields', 'owner_record_unconfirmed', 'invalid_form'];
      if (!(response.ok && body.accessUrl) && !definitive.includes(body.error ?? '')) setUnresolvedSave(true);
      if (response.ok && body.accessUrl) {
        setFiles([]);
        window.location.assign(body.accessUrl);
        return;
      }
      setError(
        body.error === 'invalid_invite'
          ? 'That code could not be opened. For classroom access, use Classroom email sign-in, then return and enter the code again. Private invites must still be valid.'
          : body.error === 'storage_disabled' || body.error === 'intake_closed' || body.error === 'policy_not_adopted'
            ? 'Family submissions are not open, so this attempt was not accepted.'
            : body.error === 'policy_consent_stale'
              ? 'The group-book terms changed, so this attempt was not accepted. Re-enter your invite to read the current terms.'
            : body.error === 'record_persist_unconfirmed'
              ? 'We could not confirm whether your submission was saved. Re-enter your invite later to check before submitting again.'
              : body.error === 'unsupported_image' || body.error === 'invalid_image'
                ? 'One of the photos could not be read. Try a JPG, PNG, or WEBP photo.'
                : 'We could not confirm whether your submission was saved. Re-enter your invite to check before submitting again.',
      );
    } catch {
      // A lost response does not establish whether the write reached storage.
      setUnresolvedSave(true);
      setError('We could not confirm whether your submission was saved because the connection or response was interrupted. Re-enter your invite to check whether it was received before submitting again.');
    } finally {
      setPhase('form');
    }
  }

  const ready = Boolean(policy) && guardian && sharedBook && schoolDisclaimer && files.length >= 1 && files.length <= MAX_GROUP_BOOK_PHOTOS;

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
              {error && <p className="help" role="alert" style={{ color: 'var(--err)' }}>{error}</p>}
              <button className="btn btn-forest btn-block btn-lg" type="submit" disabled={!invite.trim() || checking}>
                {checking ? 'Checking…' : 'Continue'} <Icon name="arrow-right" size={16} color="#f7f1e3" />
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
                <span className="field-label">1–{MAX_GROUP_BOOK_PHOTOS} private reference photos (JPG, PNG, or WEBP)</span>
                <input className="input" type="file" accept={GROUP_BOOK_ACCEPTED_PHOTO_TYPES.join(',')} multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, MAX_GROUP_BOOK_PHOTOS))} required />
                <span className="help">{files.length ? `${files.length} photo${files.length === 1 ? '' : 's'} selected` : 'Each photo is resized and re-saved on this device before sending; location data and original filenames are not sent.'}</span>
              </label>
            </section>

            {policy && (
              <section className="card stack-12" style={{ padding: 18 }}>
                <div className="eyebrow forest">Group-book terms · version {policy.version}</div>
                {POLICY_LABELS.map(([key, label]) => (
                  <div key={key} className="stack-6"><strong className="help">{label}</strong><p className="help" style={{ whiteSpace: 'pre-wrap' }}>{policy[key]}</p></div>
                ))}
              </section>
            )}

            <section className="card card-warm stack-12" style={{ padding: 18 }}>
              <div className="eyebrow forest">Explicit group-book consent</div>
              <label className="fr-row" style={{ alignItems: 'flex-start' }}><input type="checkbox" checked={guardian} onChange={(e) => setGuardian(e.target.checked)} /><span className="help"><strong>I am this child&apos;s parent or legal guardian</strong> and I am submitting only my own child&apos;s details and photos.</span></label>
              <label className="fr-row" style={{ alignItems: 'flex-start' }}><input type="checkbox" checked={sharedBook} onChange={(e) => setSharedBook(e.target.checked)} /><span className="help"><strong>I have read the group-book terms above and agree that my child&apos;s first name and illustrated likeness may appear in this private group book, shared only with the recipients those terms name.</strong> Source photos are not placed in a family gallery.</span></label>
              <label className="fr-row" style={{ alignItems: 'flex-start' }}><input type="checkbox" checked={schoolDisclaimer} onChange={(e) => setSchoolDisclaimer(e.target.checked)} /><span className="help"><strong>I understand this parent-run group book does not represent or imply school, teacher, district, or administrator approval.</strong></span></label>
              <p className="help">After saving, your private family access lets you request withdrawal, which marks your child to be left out of the book. Withdrawal timing is as stated in the terms above. Withdrawal does not delete your saved details or photos.</p>
            </section>

            {error && <p className="help" role="alert" style={{ color: 'var(--err)' }}>{error}</p>}
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
