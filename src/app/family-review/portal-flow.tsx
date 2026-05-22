'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Checkbox,
  Icon,
  PhotoPH,
  Rating,
  StoryArt,
  Steps,
  WatercolorCrest,
  Wordmark,
} from '@/components/family-review/atoms';

/* ---------- types + storage ---------------------------------------------- */

type AgeRange = '2-3' | '3-4' | '5-6' | '7-8' | '9-10';
type ChildSex = 'male' | 'female';
type Direction = 'dinosaur' | 'bedtime' | 'space';

interface FormState {
  parentName: string;
  parentEmail: string;
  childFirstName: string;
  age: AgeRange | null;
  childSex: ChildSex | null;
  consent: boolean;
  /**
   * Number of photos the parent picked in the file input. We deliberately
   * do NOT keep filenames (or any other photo metadata) anywhere — see
   * the guard test in tests/family-review-no-filename-capture.test.ts.
   */
  photoCount: number;
  direction: Direction | null;
  /** Invite code the parent used to unlock — never persisted server-side. */
  inviteCode: string;
}

const EMPTY: FormState = {
  parentName: '',
  parentEmail: '',
  childFirstName: '',
  age: null,
  childSex: null,
  consent: false,
  photoCount: 0,
  direction: null,
  inviteCode: '',
};

type SubmitState =
  | { phase: 'idle' }
  | { phase: 'uploading' }
  | { phase: 'ok'; submissionId: string; reviewUrl: string }
  | { phase: 'storage_disabled'; message: string }
  | { phase: 'error'; message: string };

// localStorage draft persistence was REMOVED for the beta. Parent name,
// parent email, child first name, invite code, consent state, and photo
// metadata are all sensitive enough that a shared-device leak via DevTools
// or a borrowed phone is unacceptable. The portal now lives entirely in
// React state for the duration of the tab session.
//
// Legacy keys (`hsb_family_review_v1`, `hsb_family_review_v2`) may still
// exist on tester devices from earlier previews — purgeLegacyDrafts()
// removes them on first mount so nothing sensitive lingers in storage.
const LEGACY_DRAFT_KEYS = [
  'hsb_family_review_v1',
  'hsb_family_review_v2',
] as const;

function purgeLegacyDrafts(): void {
  if (typeof window === 'undefined') return;
  try {
    for (const key of LEGACY_DRAFT_KEYS) {
      window.localStorage.removeItem(key);
    }
  } catch {
    /* private mode / quota — best effort */
  }
}

function extractInviteCodeFromText(value: string): string {
  const normalized = value.trim().toLowerCase();
  const embeddedCode = normalized.match(/\b[a-z0-9]+(?:-[a-z0-9]+){2,}\b/);
  if (embeddedCode) return embeddedCode[0];
  return normalized;
}

/* ---------- top-level flow ----------------------------------------------- */

type Step =
  | 'gate'
  | 'welcome'
  | 'info'
  | 'consent'
  | 'upload'
  | 'story'
  | 'confirm';

const PROGRESS_STEPS: Step[] = [
  'welcome',
  'info',
  'consent',
  'upload',
  'story',
  'confirm',
];

export default function PortalFlow() {
  const [step, setStep] = useState<Step>('gate');
  const [form, setForm] = useState<FormState>(EMPTY);
  // File objects + form fields live ONLY in React state for the duration
  // of the tab session. Nothing sensitive ever lands in localStorage —
  // see purgeLegacyDrafts() for the sweep of any keys older previews left
  // behind.
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  const [submitState, setSubmitState] = useState<SubmitState>({ phase: 'idle' });
  const submittedRef = useRef(false);

  useEffect(() => {
    purgeLegacyDrafts();
  }, []);

  // Fire the real multipart upload once, the first time we enter the
  // confirm step. Idempotent via submittedRef. State transitions:
  // idle → uploading → ok / storage_disabled / error. On 'ok' the
  // ConfirmScreen reveals the parent's private review URL and a CTA
  // to open it; we deliberately do NOT auto-navigate so the parent
  // can read the confirmation copy first.
  useEffect(() => {
    if (step !== 'confirm') return;
    if (submittedRef.current) return;
    submittedRef.current = true;
    if (typeof document !== 'undefined') {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    }
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'instant' });
    }

    setSubmitState({ phase: 'uploading' });
    (async () => {
      try {
        const fd = new FormData();
        fd.set('inviteCode', form.inviteCode);
        fd.set('parentName', form.parentName);
        fd.set('parentEmail', form.parentEmail);
        fd.set('childFirstName', form.childFirstName);
        if (form.age) fd.set('ageRange', form.age);
        if (form.childSex) {
          fd.set('pronoun', form.childSex === 'male' ? 'he/him' : 'she/her');
        }
        fd.set('consent', form.consent ? 'true' : 'false');
        if (form.direction) fd.set('direction', form.direction);
        // Photo files: appended as the same field name `photos`. The server
        // pulls them via formData.getAll('photos'). File.name reaches the
        // server frame but the server discards it — see upload/route.ts.
        for (const file of pickedFiles) {
          const photoBlob = await preparePhotoForUpload(file);
          fd.append('photos', photoBlob, 'reference-photo.jpg');
        }

        const res = await fetch('/api/family-review/upload', {
          method: 'POST',
          body: fd,
        });
        const data = (await res.json()) as {
          ok?: boolean;
          submissionId?: string;
          reviewToken?: string;
          reviewUrl?: string;
          error?: string;
          message?: string;
        };
        if (res.status === 503 && data.error === 'storage_disabled') {
          setSubmitState({
            phase: 'storage_disabled',
            message:
              data.message ??
              "Private upload isn't enabled in this environment yet.",
          });
          return;
        }
        if (!res.ok || !data.ok) {
          setSubmitState({
            phase: 'error',
            message:
              data.message ?? data.error ?? `Upload failed (HTTP ${res.status}).`,
          });
          return;
        }
        if (data.submissionId && data.reviewUrl) {
          setSubmitState({
            phase: 'ok',
            submissionId: data.submissionId,
            reviewUrl: data.reviewUrl,
          });
          // Clear the in-memory File[] now that the bytes have been
          // accepted by the server — no reason to hold them in RAM.
          setPickedFiles([]);
          return;
        }
        setSubmitState({
          phase: 'error',
          message: 'Upload completed but the response was malformed.',
        });
      } catch (err) {
        setSubmitState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'network_error',
        });
      }
    })();
    // pickedFiles is intentionally NOT in the dep array — its identity
    // changes across re-renders even when the files are the same, and
    // submittedRef already enforces single-fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const progressIndex = PROGRESS_STEPS.indexOf(step);
  const showSteps = progressIndex >= 0;

  return (
    <>
      <header className="topbar">
        <Wordmark size={14} />
        {showSteps ? (
          <Steps total={PROGRESS_STEPS.length} current={progressIndex + 1} />
        ) : (
          <span className="meta">family &amp; friends · test</span>
        )}
      </header>

      <main className="fr-container">
        {step === 'gate' && (
          <GateScreen
            onUnlock={(code) => {
              setForm({ ...form, inviteCode: code });
              setStep('welcome');
            }}
          />
        )}
        {step === 'welcome' && <WelcomeScreen onNext={() => setStep('info')} />}
        {step === 'info' && (
          <InfoScreen
            form={form}
            setForm={setForm}
            onBack={() => setStep('welcome')}
            onNext={() => setStep('consent')}
          />
        )}
        {step === 'consent' && (
          <ConsentScreen
            form={form}
            setForm={setForm}
            onBack={() => setStep('info')}
            onNext={() => setStep('upload')}
          />
        )}
        {step === 'upload' && (
          <UploadScreen
            form={form}
            setForm={setForm}
            pickedFiles={pickedFiles}
            setPickedFiles={setPickedFiles}
            onBack={() => setStep('consent')}
            onNext={() => setStep('story')}
          />
        )}
        {step === 'story' && (
          <StoryScreen
            form={form}
            setForm={setForm}
            onBack={() => setStep('upload')}
            onNext={() => setStep('confirm')}
          />
        )}
        {step === 'confirm' && (
          <ConfirmScreen
            form={form}
            submitState={submitState}
            onStartOver={() => {
              setForm(EMPTY);
              setPickedFiles([]);
              setSubmitState({ phase: 'idle' });
              submittedRef.current = false;
              setStep('gate');
            }}
          />
        )}
      </main>
    </>
  );
}

/* ---------- 1. invite gate ----------------------------------------------- */

function GateScreen({ onUnlock }: { onUnlock: (code: string) => void }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const setInviteCode = (value: string) => {
    setCode(extractInviteCodeFromText(value));
    if (err) setErr(null);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const candidate = code.trim().toLowerCase();
    if (!candidate) {
      setErr('Add the invite code from your email.');
      return;
    }
    // Do not expose real invite codes in client-side NEXT_PUBLIC config.
    // The upload endpoint validates the code server-side before storing
    // photos or form details.
    onUnlock(candidate);
  };

  return (
    <section
      className="stack-24"
      style={{ paddingTop: 40, paddingBottom: 16 }}
    >
      <div style={{ marginTop: 8, marginBottom: 4 }}>
        <WatercolorCrest />
      </div>
      <div style={{ textAlign: 'center', marginTop: 4, padding: '0 8px' }}>
        <div className="eyebrow ochre">Invite-only</div>
        <h1
          className="fr-h1 serif"
          style={{ lineHeight: 1.25, marginTop: 16 }}
        >
          A small test round, for the families who said yes.
        </h1>
        <p className="body" style={{ marginTop: 16 }}>
          You&apos;re here because we asked. Thank you. This takes about five minutes.
        </p>
      </div>

      <form onSubmit={submit} className="card card-warm" style={{ padding: 18 }}>
        <div className="field">
          <label className="field-label" htmlFor="invite-code">
            Invite code
            <span className="opt">from your email</span>
          </label>
          <div style={{ position: 'relative' }}>
            <input
              id="invite-code"
              type="text"
              className="input"
              placeholder="your-invite-code"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              value={code}
              onChange={(e) => {
                setInviteCode(e.target.value);
              }}
              onPaste={(e) => {
                const text = e.clipboardData.getData('text');
                if (text) {
                  e.preventDefault();
                  setInviteCode(text);
                }
              }}
              style={{ paddingLeft: 36 }}
            />
            <span
              style={{
                position: 'absolute',
                left: 12,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--ink-3)',
              }}
            >
              <Icon name="lock" size={14} />
            </span>
          </div>
          {err && (
            <span className="help" style={{ color: 'var(--err)' }}>
              {err}
            </span>
          )}
          <span className="help">
            Lost the email? Reply to whoever invited you — we&apos;ll resend it.
          </span>
        </div>

        <button
          type="submit"
          className="btn btn-forest btn-block btn-lg"
          style={{ marginTop: 14 }}
        >
          Continue
          <Icon name="arrow-right" size={16} color="#f7f1e3" />
        </button>
      </form>

      <p
        className="help"
        style={{
          textAlign: 'center',
          color: 'var(--ink-2)',
          marginTop: 4,
        }}
      >
        <Icon name="shield" size={11} color="var(--forest)" /> &nbsp;Two reviewers
        will see your submission. Nothing is public, nothing is sold.
      </p>
    </section>
  );
}

/* ---------- 2. welcome --------------------------------------------------- */

function WelcomeScreen({ onNext }: { onNext: () => void }) {
  return (
    <section className="stack-20" style={{ paddingTop: 8 }}>
      <div className="stack-6">
        <div className="eyebrow ochre">What happens next</div>
        <h1 className="fr-display serif">
          We&apos;ll share three sample illustrations in the style we&apos;d use
          for your&nbsp;child.
        </h1>
        <p className="body-lg">
          A reviewer reads your form details first and follows up by email
          before any samples are prepared. Your job: honestly tell us
          whether the direction feels right.
        </p>
      </div>

      <ol className="stack-12" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {[
          {
            t: 'Tell us about your child',
            d: 'First name, age range, and male/female. No surname needed.',
          },
          {
            t: 'Upload one to five private reference photos',
            d: 'Clear faces, mixed angles. Used only by your reviewer for manual beta sample prep — never public, never sold, never used to train models, original filenames not stored.',
          },
          {
            t: 'Pick a story direction',
            d: 'Dinosaurs, bedtime, or space. Just so we know the mood.',
          },
          {
            t: 'A reviewer follows up by email',
            d: "We won't generate anything on submit. A reviewer reads your details, replies to confirm, and only then prepares three sample directions.",
          },
        ].map((item, i) => (
          <li key={item.t} className="card" style={{ padding: 14 }}>
            <div className="fr-row" style={{ gap: 14, alignItems: 'flex-start' }}>
              <span
                className="serif"
                style={{
                  flex: '0 0 28px',
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  background: 'var(--leaf)',
                  color: 'var(--forest)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 14,
                }}
              >
                {i + 1}
              </span>
              <div className="stack-4" style={{ flex: 1 }}>
                <span className="fr-h3 serif">{item.t}</span>
                <span className="help">{item.d}</span>
              </div>
            </div>
          </li>
        ))}
      </ol>

      <button className="btn btn-forest btn-block btn-lg" onClick={onNext}>
        Get started
        <Icon name="arrow-right" size={16} color="#f7f1e3" />
      </button>
      <p className="help" style={{ textAlign: 'center' }}>
        No payment. No commitment. You can stop any time.
      </p>
    </section>
  );
}

/* ---------- 3. info ------------------------------------------------------ */

const AGES: AgeRange[] = ['2-3', '3-4', '5-6', '7-8', '9-10'];
const CHILD_SEX_OPTIONS: { value: ChildSex; label: string }[] = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
];

function InfoScreen({
  form,
  setForm,
  onBack,
  onNext,
}: {
  form: FormState;
  setForm: (next: FormState) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const canContinue =
    form.parentName.trim().length > 0 &&
    /\S+@\S+\.\S+/.test(form.parentEmail) &&
    form.childFirstName.trim().length > 0 &&
    form.age !== null &&
    form.childSex !== null;

  return (
    <section className="stack-20" style={{ paddingTop: 8 }}>
      <div className="stack-6">
        <div className="eyebrow forest">A little about you</div>
        <h1 className="fr-h1 serif">Who are we making this&nbsp;for?</h1>
        <p className="body">First name only for your child — no surname, no school.</p>
      </div>

      <div className="card" style={{ padding: 16 }}>
        <div className="stack-14">
          <div className="field">
            <label className="field-label" htmlFor="parent-name">Your name</label>
            <input
              id="parent-name"
              className="input"
              autoComplete="given-name"
              value={form.parentName}
              onChange={(e) => setForm({ ...form, parentName: e.target.value })}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="parent-email">Email</label>
            <input
              id="parent-email"
              type="email"
              className="input"
              autoComplete="email"
              value={form.parentEmail}
              onChange={(e) => setForm({ ...form, parentEmail: e.target.value })}
            />
            <span className="help">We use this only to send the three samples back.</span>
          </div>
          <hr className="rule" />
          <div className="field">
            <label className="field-label" htmlFor="child-name">
              Child&apos;s first name
              <span className="opt">just the first name</span>
            </label>
            <input
              id="child-name"
              className="input"
              autoComplete="off"
              value={form.childFirstName}
              onChange={(e) => setForm({ ...form, childFirstName: e.target.value })}
            />
          </div>
          <div className="field">
            <span className="field-label">Age range</span>
            <div className="pillrow">
              {AGES.map((a) => (
                <button
                  key={a}
                  type="button"
                  className={'pill tone-forest' + (form.age === a ? ' on' : '')}
                  onClick={() => setForm({ ...form, age: a })}
                  aria-pressed={form.age === a}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span className="field-label">Male or female</span>
            <div className="pillrow">
              {CHILD_SEX_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={'pill tone-forest' + (form.childSex === option.value ? ' on' : '')}
                  onClick={() => setForm({ ...form, childSex: option.value })}
                  aria-pressed={form.childSex === option.value}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="fr-row-between">
        <button className="btn btn-ghost" onClick={onBack}>
          Back
        </button>
        <button
          className="btn btn-forest"
          onClick={onNext}
          disabled={!canContinue}
        >
          Continue
          <Icon name="arrow-right" size={16} color="#f7f1e3" />
        </button>
      </div>
    </section>
  );
}

/* ---------- 4. consent --------------------------------------------------- */

const CONSENT_ITEMS: { t: string; d: string }[] = [
  {
    t: 'Your reference photos are used only for beta sample prep.',
    d: 'Two named reviewers look at them to hand-prepare your samples. Never public, never sold, never used to train models by us. Original filenames are stripped on upload.',
  },
  {
    t: 'You can ask us to delete everything at any time.',
    d: "One email, no questions. We confirm within 48 hours.",
  },
  {
    t: 'No social posts, no ads, no resale.',
    d: 'If we ever wanted to share a sample publicly we would ask you first.',
  },
  {
    t: 'We only ask for your child\'s first name — not surname, not school.',
    d: 'For you, we keep your name and email so a reviewer can write back. For your child, only the first name and age range. No city, no birthdate, no school.',
  },
  {
    t: 'You can stop the test at any step before we send samples.',
    d: 'Close the tab. Reply to the invite. Whatever is easiest.',
  },
  {
    t: 'We are a small team. This is honest research, not a product launch.',
    d: 'Three real people read every reply.',
  },
];

function ConsentScreen({
  form,
  setForm,
  onBack,
  onNext,
}: {
  form: FormState;
  setForm: (next: FormState) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <section className="stack-20" style={{ paddingTop: 8 }}>
      <div className="stack-6">
        <div className="eyebrow forest">Plain-English consent</div>
        <h1 className="fr-h1 serif">Here&apos;s what we will and won&apos;t do.</h1>
        <p className="body">
          Six short points. No legalese, no traps. Read them all and then check the box.
        </p>
      </div>

      <ol className="stack-12" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {CONSENT_ITEMS.map((item, i) => (
          <li key={item.t} className="card" style={{ padding: 14 }}>
            <div className="fr-row" style={{ gap: 12, alignItems: 'flex-start' }}>
              <span
                style={{
                  flex: '0 0 22px',
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  background: 'var(--leaf)',
                  color: 'var(--forest)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                }}
              >
                {i + 1}
              </span>
              <div className="stack-4" style={{ flex: 1 }}>
                <span className="fr-h3 serif">{item.t}</span>
                <span className="help">{item.d}</span>
              </div>
            </div>
          </li>
        ))}
      </ol>

      <div className="card card-warm" style={{ padding: 16 }}>
        <Checkbox
          checked={form.consent}
          onChange={(next) => setForm({ ...form, consent: next })}
        >
          <strong>I&apos;ve read all six points above and I agree.</strong>
        </Checkbox>
      </div>

      <div className="fr-row-between">
        <button className="btn btn-ghost" onClick={onBack}>
          Back
        </button>
        <button
          className="btn btn-forest"
          onClick={onNext}
          disabled={!form.consent}
        >
          Continue
          <Icon name="arrow-right" size={16} color="#f7f1e3" />
        </button>
      </div>
    </section>
  );
}

/* ---------- 5. photo upload (UI-only guidance) --------------------------- */

// Photo upload constraints — must match server-side validation in
// src/app/api/family-review/upload/route.ts. The UI clamps client-side
// for nicer UX; the server is still authoritative.
const PHOTO_MAX_FILES = 5;
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const PHOTO_UPLOAD_MAX_DIMENSION = 1600;
const PHOTO_UPLOAD_JPEG_QUALITY = 0.82;
const PHOTO_ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);
const PHOTO_ACCEPT_ATTR =
  'image/jpeg,image/jpg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif';

async function preparePhotoForUpload(file: File): Promise<Blob> {
  if (
    file.size <= 1_500_000 &&
    (file.type === 'image/jpeg' ||
      file.type === 'image/jpg' ||
      file.type === 'image/png' ||
      file.type === 'image/webp')
  ) {
    return file;
  }

  const image = await decodePhoto(file);
  const scale = Math.min(
    1,
    PHOTO_UPLOAD_MAX_DIMENSION / Math.max(image.width, image.height),
  );
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', PHOTO_UPLOAD_JPEG_QUALITY);
  });
  return blob ?? file;
}

async function decodePhoto(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try {
      return await window.createImageBitmap(file);
    } catch {
      // Fall through to HTMLImageElement decode for mobile browser quirks.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function UploadScreen({
  form,
  setForm,
  pickedFiles,
  setPickedFiles,
  onBack,
  onNext,
}: {
  form: FormState;
  setForm: (next: FormState) => void;
  pickedFiles: File[];
  setPickedFiles: React.Dispatch<React.SetStateAction<File[]>>;
  onBack: () => void;
  onNext: () => void;
}) {
  const [pickError, setPickError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);

  // Mirror the picked count into form state so saveDraft keeps it
  // across refresh-within-step. The File[] itself is NOT persisted.
  useEffect(() => {
    setForm({ ...form, photoCount: pickedFiles.length });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedFiles.length]);

  useEffect(() => {
    const urls = pickedFiles.slice(0, 3).map((file) => URL.createObjectURL(file));
    setPreviewUrls(urls);
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [pickedFiles]);

  const fileInput = useRef<HTMLInputElement>(null);

  const isSupportedPhoto = (file: File) => {
    if (PHOTO_ALLOWED_MIME.has(file.type)) return true;
    // Some mobile browsers/cameras provide blank or nonstandard MIME
    // values for HEIC/JPG files. Use the name only for transient
    // validation; it is never stored in form state or persisted.
    return /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name || '');
  };

  const acceptFiles = (incoming: FileList | null) => {
    if (!incoming || incoming.length === 0) return;
    setPickError(null);
    setPickedFiles((prev) => {
      const room = Math.max(0, PHOTO_MAX_FILES - prev.length);
      if (room === 0) {
        setPickError(`You can pick at most ${PHOTO_MAX_FILES} photos.`);
        return prev;
      }
      const next = [...prev];
      let added = 0;
      // We deliberately iterate by index and do not store File.name
      // anywhere — only the File object itself, which the browser
      // hands off to the server multipart frame at submit time.
      for (let i = 0; i < incoming.length && added < room; i += 1) {
        const f = incoming.item(i);
        if (!f) continue;
        if (!isSupportedPhoto(f)) {
          setPickError(
            'One photo is not a supported image type. Use JPG, PNG, WEBP, or HEIC.',
          );
          continue;
        }
        if (f.size > PHOTO_MAX_BYTES) {
          setPickError('One photo is larger than 10 MB.');
          continue;
        }
        next.push(f);
        added += 1;
      }
      return next;
    });
    // Do not clear the native input immediately. On mobile browsers
    // the selected File object can be tied to that control; clearing it
    // right away can make the portal look like nothing was selected.
  };

  const removeAt = (idx: number) => {
    setPickedFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const count = pickedFiles.length;
  const canContinue = count >= 1;
  const uploadZoneStyle = dragActive
    ? {
        borderColor: 'var(--forest)',
        background: 'rgba(89, 112, 91, 0.12)',
      }
    : undefined;

  return (
    <section className="stack-20" style={{ paddingTop: 8 }}>
      <div className="stack-6">
        <div className="eyebrow forest">Photo references</div>
        <h1 className="fr-h1 serif">Pick your reference&nbsp;photos.</h1>
        <p className="body">
          1–5 photos with clear faces. They&apos;re uploaded privately to
          your reviewer when you submit — never posted publicly. We
          don&apos;t keep the original filenames.
        </p>
      </div>

      <div
        className="upload-zone"
        style={{ ...uploadZoneStyle, position: 'relative' }}
        onDragEnter={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragActive(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragActive(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragActive(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragActive(false);
          acceptFiles(e.dataTransfer.files);
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') fileInput.current?.click();
        }}
      >
        <input
          ref={fileInput}
          type="file"
          accept={PHOTO_ACCEPT_ATTR}
          multiple
          aria-label="Add reference photos"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            opacity: 0,
            cursor: 'pointer',
            zIndex: 2,
          }}
          onChange={(e) => acceptFiles(e.target.files)}
        />
        <Icon name="upload" size={24} color="var(--forest)" />
        <span className="fr-h3 serif">Add photos or drag them here</span>
        <span className="help">
          JPG / PNG / WEBP / HEIC · up to 10 MB each · 1–5 photos.
          Uploaded only after you tap Continue on the final step.
        </span>
      </div>
      {pickError && (
        <p className="help" style={{ color: 'var(--err)' }}>
          {pickError}
        </p>
      )}
      {count > 0 && (
        <div className="card card-warm" style={{ padding: 14 }}>
          <div className="fr-row" style={{ alignItems: 'center', gap: 10 }}>
            <Icon name="check" size={16} color="var(--forest)" />
            <div className="stack-2">
              <span className="fr-h3 serif">
                {count === 1 ? '1 photo selected' : `${count} photos selected`}
              </span>
              <span className="help">
                Tap Continue when you&apos;re ready. We&apos;ll shrink phone
                photos before upload so they send reliably.
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="fr-row3">
        {Array.from({ length: 3 }).map((_, i) => {
          const filled = i < pickedFiles.length;
          const previewUrl = previewUrls[i];
          return (
            <div key={i} style={{ position: 'relative' }}>
              {filled ? (
                <>
                  <div className="photo-ph" style={{ aspectRatio: '1 / 1' }}>
                    {previewUrl ? (
                      <img
                        src={previewUrl}
                        alt={`Selected reference ${i + 1}`}
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                          display: 'block',
                        }}
                      />
                    ) : (
                      <span className="ph-label">{`0${i + 1}`}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeAt(i)}
                    aria-label={`Remove photo ${i + 1}`}
                    style={{
                      position: 'absolute',
                      top: 6,
                      right: 6,
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                      background: 'rgba(34,28,20,0.7)',
                      color: 'var(--paper)',
                      border: 0,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                    }}
                  >
                    <Icon name="x" size={12} color="var(--paper)" />
                  </button>
                </>
              ) : (
                <div
                  className="photo-ph"
                  style={{
                    aspectRatio: '1 / 1',
                    background: 'rgba(252, 248, 239, 0.6)',
                    borderStyle: 'dashed',
                    color: 'var(--ink-4)',
                  }}
                >
                  <span className="ph-label">empty</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {count > 3 && (
        <p className="help">+{count - 3} more added beyond the three previewed here.</p>
      )}

      <div className="card card-quiet" style={{ padding: 14 }}>
        <div className="fr-row-between" style={{ marginBottom: 10 }}>
          <div className="eyebrow ochre">Good references</div>
          <div className="eyebrow" style={{ color: 'var(--ink-3)' }}>Skip these</div>
        </div>
        <div className="fr-row2">
          <div className="stack-6">
            <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--ink-2)', fontSize: 13 }}>
              <li>Face fully visible</li>
              <li>Natural light, not blurry</li>
              <li>A couple of angles</li>
              <li>Their usual expression</li>
            </ul>
          </div>
          <div className="stack-6">
            <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--ink-3)', fontSize: 13 }}>
              <li>Sunglasses or masks</li>
              <li>Group photos with many faces</li>
              <li>Heavy filters</li>
              <li>Anything with school logos</li>
            </ul>
          </div>
        </div>
      </div>

      <p className="help" style={{ textAlign: 'center' }}>
        <Icon name="shield" size={11} color="var(--forest)" /> &nbsp;Photos
        are uploaded privately when you submit and stored only for your
        own reviewer. Original filenames are stripped. Nothing is public,
        nothing trains a model.
      </p>

      <div className="fr-row-between">
        <button className="btn btn-ghost" onClick={onBack}>
          Back
        </button>
        <button
          className="btn btn-forest"
          onClick={onNext}
          disabled={!canContinue}
        >
          Continue
          <Icon name="arrow-right" size={16} color="#f7f1e3" />
        </button>
      </div>
    </section>
  );
}

/* ---------- 6. story direction ------------------------------------------- */

const STORIES: { id: Direction; kind: 'dino' | 'bedtime' | 'space'; t: string; d: string }[] = [
  {
    id: 'dinosaur',
    kind: 'dino',
    t: 'Dinosaur adventure',
    d: 'A muddy valley, soft ferns, a small brave morning.',
  },
  {
    id: 'bedtime',
    kind: 'bedtime',
    t: 'Bedtime wonder',
    d: 'Fireflies, a nest of moss, the hush before sleep.',
  },
  {
    id: 'space',
    kind: 'space',
    t: 'Space explorer',
    d: 'A small paper rocket, distant rings, tail-prints in stardust.',
  },
];

function StoryScreen({
  form,
  setForm,
  onBack,
  onNext,
}: {
  form: FormState;
  setForm: (next: FormState) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <section className="stack-20" style={{ paddingTop: 8 }}>
      <div className="stack-6">
        <div className="eyebrow forest">Story direction</div>
        <h1 className="fr-h1 serif">Pick a mood for the samples.</h1>
        <p className="body">
          We only need one. This just tells us where to point the watercolor.
        </p>
      </div>

      <div className="stack-12">
        {STORIES.map((s) => {
          const on = form.direction === s.id;
          return (
            <button
              key={s.id}
              type="button"
              className={'story-card' + (on ? ' on' : '')}
              onClick={() => setForm({ ...form, direction: s.id })}
              aria-pressed={on}
              style={{ textAlign: 'left', font: 'inherit' }}
            >
              <span className="ck" />
              <div className="art">
                <StoryArt kind={s.kind} />
              </div>
              <div className="stack-4">
                <span className="fr-h3 serif">{s.t}</span>
                <span className="help">{s.d}</span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="fr-row-between">
        <button className="btn btn-ghost" onClick={onBack}>
          Back
        </button>
        <button
          className="btn btn-forest"
          onClick={onNext}
          disabled={form.direction === null}
        >
          Continue
          <Icon name="arrow-right" size={16} color="#f7f1e3" />
        </button>
      </div>
    </section>
  );
}

/* ---------- 7. confirm --------------------------------------------------- */

function ConfirmScreen({
  form,
  submitState,
  onStartOver,
}: {
  form: FormState;
  submitState: SubmitState;
  onStartOver: () => void;
}) {
  const childName = form.childFirstName.trim() || 'your child';
  const directionLabel = useMemo(() => {
    const found = STORIES.find((s) => s.id === form.direction);
    return found?.t ?? 'a direction you picked';
  }, [form.direction]);

  // Adaptive confirmation copy. We deliberately avoid any phrasing that
  // implies "instant generation" — the actual samples are hand-prepared
  // by two named reviewers from the manual sample briefs in
  // src/lib/family-review/sample-briefs.ts.
  const banner = (() => {
    switch (submitState.phase) {
      case 'uploading':
        return {
          eyebrow: 'Uploading…',
          headline: 'Sending your photos privately.',
          body: `One moment — we're uploading the references for ${childName} to your reviewer only.`,
          tone: 'pending' as const,
        };
      case 'ok':
        return {
          eyebrow: 'Submission received',
          headline: 'We received your test submission and private photo references.',
          body: `${directionLabel} is saved. A reviewer will email you within a few days. Samples are hand-prepared — there is no automated image generation on submit.`,
          tone: 'ok' as const,
        };
      case 'storage_disabled':
        return {
          eyebrow: 'Private upload not enabled',
          headline: "Private upload isn't enabled in this environment yet.",
          body:
            submitState.message ||
            'Please reply to your invite email — your reviewer will collect the details and reference photos manually.',
          tone: 'soft' as const,
        };
      case 'error':
        return {
          eyebrow: "Couldn't reach our server",
          headline: 'Submission failed.',
          body: `Your reference photos were not uploaded. ${submitState.message ?? ''} Please try again, or reply to your invite email if it keeps failing.`,
          tone: 'soft' as const,
        };
      case 'idle':
      default:
        return {
          eyebrow: 'Ready to submit',
          headline: 'Almost there.',
          body: '',
          tone: 'pending' as const,
        };
    }
  })();

  const iconColor =
    banner.tone === 'ok'
      ? 'var(--forest)'
      : banner.tone === 'pending'
      ? 'var(--ochre-2)'
      : 'var(--ink-3)';
  const iconBg =
    banner.tone === 'ok'
      ? 'var(--leaf)'
      : banner.tone === 'pending'
      ? '#f0e7d4'
      : 'var(--paper-2)';

  return (
    <section className="stack-20" style={{ paddingTop: 32, textAlign: 'center' }}>
      <div
        style={{
          width: 72,
          height: 72,
          borderRadius: '50%',
          background: iconBg,
          color: iconColor,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto',
        }}
        aria-live="polite"
      >
        <Icon
          name={banner.tone === 'ok' ? 'check' : 'sparkle'}
          size={32}
          color={iconColor}
          stroke={2.4}
        />
      </div>

      <div className="stack-6">
        <div className="eyebrow ochre">{banner.eyebrow}</div>
        <h1 className="fr-display serif">{banner.headline}</h1>
        {banner.body && <p className="body-lg">{banner.body}</p>}
      </div>

      {submitState.phase === 'ok' && (
        <div
          className="card card-warm"
          style={{ padding: 18, textAlign: 'left' }}
        >
          <div className="eyebrow forest" style={{ marginBottom: 8 }}>
            Your private review link
          </div>
          <p className="help" style={{ marginBottom: 10 }}>
            Bookmark this — it&apos;s the only place you&apos;ll see your samples
            once a reviewer has prepared them. Don&apos;t share it; anyone with
            the link can see what you submitted.
          </p>
          <code
            className="mono"
            style={{
              display: 'block',
              padding: '8px 10px',
              background: 'var(--paper)',
              border: '1px solid var(--line)',
              borderRadius: 6,
              fontSize: 12.5,
              wordBreak: 'break-all',
              color: 'var(--ink-2)',
            }}
          >
            {submitState.reviewUrl}
          </code>
          <div className="stack-12" style={{ marginTop: 14 }}>
            <a
              href={submitState.reviewUrl}
              className="btn btn-forest btn-block btn-lg"
              style={{
                textDecoration: 'none',
                borderBottom: 'none',
              }}
            >
              Open your private review page
              <Icon name="arrow-right" size={16} color="#f7f1e3" />
            </a>
          </div>
        </div>
      )}

      <div className="card card-quiet" style={{ padding: 14, textAlign: 'left' }}>
        <div className="eyebrow forest" style={{ marginBottom: 6 }}>
          What happens next
        </div>
        <p className="help" style={{ marginBottom: 6 }}>
          1. A reviewer reads your form details and references, then emails
          you to confirm. No automated image generation runs on submit.
        </p>
        <p className="help" style={{ marginBottom: 6 }}>
          2. Two named reviewers hand-prepare three sample directions:
          a cover hero portrait, one page matched to {directionLabel},
          and a bedtime keepsake page. This takes a few days, not seconds.
        </p>
        <p className="help">
          3. You&apos;ll see the samples on your private review page above,
          where you can leave feedback. If you like them, you&apos;ll get
          a beta discount code toward a full-length book — no surprise
          charges.
        </p>
      </div>

      <div className="card card-warm" style={{ padding: 18, textAlign: 'left' }}>
        <div className="eyebrow forest" style={{ marginBottom: 8 }}>
          What you submitted
        </div>
        <div className="stack-8">
          <Row
            label="Parent"
            value={`${form.parentName.trim() || '—'} · ${
              form.parentEmail.trim() || '—'
            }`}
          />
          <Row
            label="Child"
            value={`${childName}${form.age ? ` · age ${form.age}` : ''}${
              form.childSex ? ` · ${form.childSex}` : ''
            }`}
          />
          <Row
            label="Reference photos"
            value={
              submitState.phase === 'ok'
                ? `${form.photoCount} uploaded privately`
                : form.photoCount > 0
                ? `${form.photoCount} ready to upload`
                : 'none picked'
            }
          />
          <Row label="Direction" value={directionLabel} />
          <Row label="Consent" value={form.consent ? 'Signed' : 'Missing'} />
        </div>
      </div>

      <p className="help">
        Want to delete everything?{' '}
        <a href="mailto:hello@herostorybooks.com?subject=Delete%20my%20family%20test%20submission">
          Email us
        </a>
        . One reply is enough — we confirm within 48 hours.
      </p>

      <div className="stack-12">
        <button
          className="btn-link"
          onClick={onStartOver}
          style={{ alignSelf: 'center' }}
        >
          Start over
        </button>
      </div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="fr-row-between">
      <span className="meta">{label}</span>
      <span style={{ fontSize: 13, color: 'var(--ink)', fontWeight: 500 }}>{value}</span>
    </div>
  );
}
