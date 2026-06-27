'use client';
import React, { useState, useRef, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { Progress } from '@/components/ui/progress';
import { PHOTO_UPLOAD_HELP, PRINT_PREVIEW_PROMISE } from '@/lib/checkout-flow';
import { VoiceRecorderSection } from '@/components/checkout/VoiceRecorderSection';
import { GuidedPhotoCapture } from '@/components/checkout/GuidedPhotoCapture';
import { CHECKOUT_SAMPLE_IMAGES, STORY_OCCASIONS, STORY_THEMES } from '@/lib/story-catalog';
import {
  appendGuidedCaptureToFormData,
  isGuidedPhotoCaptureEnabled,
  type GuidedPhotoFile,
} from '@/lib/guided-photo-capture';

// ── Constants ──────────────────────────────────────────────────────────────

const LAUNCH_THEME_IDS = new Set([
  'brave-explorer',
  'space-voyager',
  'ocean-dreams',
  'dinosaur-discovery',
  'dragon-quest',
  'royal-adventure',
]);

const THEMES = STORY_THEMES
  .filter((theme) => LAUNCH_THEME_IDS.has(theme.id))
  .map((theme) => ({
    id: theme.id,
    label: theme.name,
    emoji: theme.emoji,
    desc: theme.description,
  }));

const LESSONS = [
  { id: 'courage',       label: 'Courage',       emoji: '🦁' },
  { id: 'kindness',      label: 'Kindness',       emoji: '💛' },
  { id: 'friendship',    label: 'Friendship',     emoji: '🤝' },
  { id: 'creativity',    label: 'Creativity',     emoji: '🎨' },
  { id: 'perseverance',  label: 'Never Give Up',  emoji: '⭐' },
];

const OCCASIONS = STORY_OCCASIONS;

// FORMATS — display copy aligned to the editorial landing tone:
// no emoji-as-icon; proof-first promise (digital proof → parent approval
// → final PDF / print). Prices match src/lib/orders.ts FORMAT_META
// priceCents (1900 / 3900 / 6400) and src/lib/pricing.ts. Update all
// three together if backend pricing changes.
const FORMATS = [
  {
    id: 'digital',
    label: 'Digital',
    price: '$19',
    priceNum: 19,
    delivery: 'Digital proof first, then final PDF after approval',
    deliveryDetail: 'Proofs usually ready within 2 business days · Read on any device · Print at home',
  },
  {
    id: 'classic',
    label: 'Classic',
    price: '$39',
    priceNum: 39,
    badge: 'Most Popular',
    delivery: 'Softcover ships 5–7 business days after proof approval',
    deliveryDetail: 'Digital proof first; final PDF included after you approve',
  },
  {
    id: 'premium',
    label: 'Premium',
    price: '$64',
    priceNum: 64,
    delivery: 'Hardcover ships 5–7 business days after proof approval',
    deliveryDetail: 'Digital proof first; final PDF included after you approve',
  },
];

const VOICE_BETA_ENABLED = process.env.NEXT_PUBLIC_HSB_VOICE_BETA !== 'false';

const STORAGE_KEY = 'hsb_order_v1';
const STORAGE_TTL = 7 * 24 * 60 * 60 * 1000;
const RECOVERY_DEBOUNCE_MS = 1500;

function looksLikeEmail(e: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

const SAMPLE_IMAGES = CHECKOUT_SAMPLE_IMAGES;
const CHECKOUT_STEPS = [
  { id: 'theme', label: 'Adventure' },
  { id: 'hero', label: 'Hero' },
  { id: 'format', label: 'Format' },
  { id: 'email', label: 'Email' },
  { id: 'photo', label: 'Photo' },
];

// ── Types ──────────────────────────────────────────────────────────────────

interface FormState {
  photoFile: File | null;
  photoDataUrl: string | null;
  theme: string;
  childName: string;
  childAge: string;
  childPronouns: string;
  lesson: string;
  occasion: string;
  giftMessage: string;
  characterNotes: string;
  skinTone: string;
  hairStyle: string;
  eyewear: string;
  bookFormat: string;
  email: string;
  voiceFile: File | null;
  voicePreviewUrl: string | null;
  voiceSource: 'recorded' | 'uploaded' | null;
  voiceConsent: boolean;
  supportingCharacters: SupportingCharacterForm[];
}


interface SupportingCharacterForm {
  id: string;
  name: string;
  relationship: string;
  kind: 'human' | 'pet';
  species: string;
  photoFile: File | null;
  photoDataUrl: string | null;
}

const emptyForm: FormState = {
  photoFile: null,
  photoDataUrl: null,
  theme: '',
  childName: '',
  childAge: '',
  childPronouns: '',
  lesson: '',
  occasion: '',
  giftMessage: '',
  characterNotes: '',
  skinTone: '',
  hairStyle: '',
  eyewear: '',
  bookFormat: 'classic',
  email: '',
  voiceFile: null,
  voicePreviewUrl: null,
  voiceSource: null,
  voiceConsent: false,
  supportingCharacters: [],
};

// ── Helpers ────────────────────────────────────────────────────────────────

function saveProgress(form: FormState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      theme: form.theme,
      childName: form.childName,
      childAge: form.childAge,
      childPronouns: form.childPronouns,
      lesson: form.lesson,
      occasion: form.occasion,
      giftMessage: form.giftMessage,
      characterNotes: form.characterNotes,
      skinTone: form.skinTone,
      hairStyle: form.hairStyle,
      eyewear: form.eyewear,
      supportingCharacters: form.supportingCharacters.map(({ photoFile, photoDataUrl, ...character }) => character),
      bookFormat: form.bookFormat,
      email: form.email,
      savedAt: Date.now(),
    }));
  } catch { /* localStorage unavailable */ }
}

function loadProgress(): Partial<FormState> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (Date.now() - (data.savedAt ?? 0) > STORAGE_TTL) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return data;
  } catch { return null; }
}

const CHILD_NAME_PARAM_MAX_LEN = 24;
const CHILD_NAME_PARAM_STRIP_PUNCTUATION_RE = /[<>{}`$&;]/g;
const CHILD_NAME_PARAM_STRIP_CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/g;

function sanitizeChildNameParam(value: string | null): string {
  return (value ?? '')
    .replace(CHILD_NAME_PARAM_STRIP_PUNCTUATION_RE, '')
    .replace(CHILD_NAME_PARAM_STRIP_CONTROL_CHARS_RE, '')
    .trim()
    .slice(0, CHILD_NAME_PARAM_MAX_LEN);
}

// ── Component ──────────────────────────────────────────────────────────────

export function CheckoutForm() {
  const [form, setForm] = useState<FormState>(emptyForm);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const guidedCaptureEnabled = isGuidedPhotoCaptureEnabled();
  const [guidedFrames, setGuidedFrames] = useState<GuidedPhotoFile[]>([]);
  const [guidedConsent, setGuidedConsent] = useState(false);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restore saved progress on mount + honor checkout query params.
  // NamePreview passes ?childName=... as the only handoff into Checkout; if
  // present, it should pre-fill/override the saved child name while leaving
  // the rest of any recoverable checkout progress intact.
  useEffect(() => {
    const saved = loadProgress();
    const params = new URLSearchParams(window.location.search);
    const formatFromUrl = params.get('format');
    const childNameFromUrl = sanitizeChildNameParam(params.get('childName'));
    const nextFormat = formatFromUrl && FORMATS.some((fmt) => fmt.id === formatFromUrl)
      ? formatFromUrl
      : '';
    const queryPrefill: Partial<FormState> = {
      ...(nextFormat ? { bookFormat: nextFormat } : {}),
      ...(childNameFromUrl ? { childName: childNameFromUrl } : {}),
    };

    if (saved && (saved.childName || saved.theme)) {
      setShowRecovery(true);
      setForm(prev => ({ ...prev, ...saved, ...queryPrefill }));
      return;
    }

    if (nextFormat || childNameFromUrl) {
      setForm(prev => ({ ...prev, ...queryPrefill }));
    }
  }, []);

  // Auto-save on meaningful changes
  useEffect(() => {
    if (form.childName || form.theme || form.email) {
      saveProgress(form);
    }
  }, [form.theme, form.childName, form.childAge, form.childPronouns, form.lesson, form.occasion,
      form.giftMessage, form.characterNotes, form.skinTone, form.hairStyle, form.eyewear,
      form.supportingCharacters, form.bookFormat, form.email]);

  // Server-side recovery capture — debounced, fires when email + any key field is present
  useEffect(() => {
    if (!looksLikeEmail(form.email) || (!form.childName && !form.theme)) return;
    if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
    recoveryTimerRef.current = setTimeout(() => {
      fetch('/api/recovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: form.email,
          childName: form.childName || undefined,
          bookFormat: form.bookFormat || undefined,
          theme: form.theme || undefined,
          captureSource: 'checkout_form',
        }),
      }).catch(() => {}); // fire-and-forget — never surface errors to the user
    }, RECOVERY_DEBOUNCE_MS);
    return () => {
      if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
    };
  }, [form.email, form.childName, form.bookFormat, form.theme]);

  const set = (key: keyof FormState, value: string) =>
    setForm(prev => ({ ...prev, [key]: value }));

  const selectedFormat = FORMATS.find((fmt) => fmt.id == form.bookFormat) ?? FORMATS[1];
  const completedStepCount = [
    Boolean(form.theme),
    Boolean(form.childName),
    Boolean(form.bookFormat),
    looksLikeEmail(form.email),
    Boolean(form.photoFile),
  ].filter(Boolean).length;
  const progressValue = (completedStepCount / CHECKOUT_STEPS.length) * 100;

  const processPhoto = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      setForm(prev => ({
        ...prev,
        photoFile: file,
        photoDataUrl: e.target?.result as string,
      }));
    };
    reader.readAsDataURL(file);
  }, []);



  const addSupportingCharacter = () => {
    setForm(prev => ({
      ...prev,
      supportingCharacters: [
        ...prev.supportingCharacters,
        {
          id: `support-${Date.now()}-${prev.supportingCharacters.length + 1}`,
          name: '',
          relationship: '',
          kind: 'human',
          species: '',
          photoFile: null,
          photoDataUrl: null,
        },
      ],
    }));
  };

  const updateSupportingCharacter = (
    id: string,
    patch: Partial<Omit<SupportingCharacterForm, 'id' | 'photoFile' | 'photoDataUrl'>>,
  ) => {
    setForm(prev => ({
      ...prev,
      supportingCharacters: prev.supportingCharacters.map(character =>
        character.id === id ? { ...character, ...patch } : character,
      ),
    }));
  };

  const removeSupportingCharacter = (id: string) => {
    setForm(prev => ({
      ...prev,
      supportingCharacters: prev.supportingCharacters.filter(character => character.id !== id),
    }));
  };

  const processSupportingPhoto = (id: string, file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      setForm(prev => ({
        ...prev,
        supportingCharacters: prev.supportingCharacters.map(character =>
          character.id === id
            ? { ...character, photoFile: file, photoDataUrl: e.target?.result as string }
            : character,
        ),
      }));
    };
    reader.readAsDataURL(file);
  };

  const missingSupportingHumanPhotos = form.supportingCharacters.filter(
    character => character.kind === 'human' && (character.name || character.relationship) && !character.photoFile,
  );

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) processPhoto(file);
  }, [processPhoto]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    if (recoveryTimerRef.current) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }

    try {
      const payload = new FormData();
      payload.set('childName', form.childName);
      payload.set('childAge', form.childAge);
      payload.set('childPronouns', form.childPronouns);
      payload.set('theme', form.theme);
      payload.set('lesson', form.lesson);
      payload.set('occasion', form.occasion);
      payload.set('giftMessage', form.giftMessage);
      payload.set('characterNotes', form.characterNotes);
      const supportingCharactersPayload = form.supportingCharacters
        .filter(character => character.name.trim() || character.relationship.trim() || character.species.trim())
        .map(character => ({
          id: character.id,
          name: character.name.trim(),
          relationship: character.relationship.trim(),
          kind: character.kind,
          species: character.kind === 'pet' ? character.species.trim() : '',
        }));
      payload.set('supportingCharacters', JSON.stringify(supportingCharactersPayload));
      form.supportingCharacters.forEach((character, index) => {
        if (character.photoFile) {
          payload.set(`supportingCharacterPhoto:${character.id}`, character.photoFile);
          payload.set(`supportingCharacterPhoto:${index}`, character.photoFile);
        }
      });
      payload.set('appearanceOptions', JSON.stringify({
        skinTone: form.skinTone,
        hairStyle: form.hairStyle,
        eyewear: form.eyewear,
      }));
      payload.set('bookFormat', form.bookFormat);
      payload.set('email', form.email);
      if (form.photoFile) {
        payload.set('photo', form.photoFile);
      }
      // Optional guided child stills. Appends only parent-approved still photos; no video.
      if (guidedCaptureEnabled && guidedConsent && guidedFrames.length > 0) {
        appendGuidedCaptureToFormData(payload, guidedFrames);
      }
      if (VOICE_BETA_ENABLED && form.voiceFile) {
        payload.set('voice', form.voiceFile);
        payload.set('voiceConsent', form.voiceConsent ? 'true' : 'false');
        if (form.voiceSource) payload.set('voiceSource', form.voiceSource);
      }

      const response = await fetch('/api/order', {
        method: 'POST',
        body: payload,
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result?.error || 'Order submission failed');
      }
      setSuccess(true);
      localStorage.removeItem(STORAGE_KEY);
      setTimeout(() => {
        window.location.href = result.redirectTo || '/thank-you';
      }, 1200);
    } catch (error) {
      console.error(error);
      alert(error instanceof Error ? error.message : 'We could not save your order. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (success) {
    return (
      <main className="min-h-screen bg-cream flex items-center justify-center px-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-white rounded-2xl border-2 border-green-200 p-12 text-center max-w-md w-full shadow-lg"
        >
          <div className="text-6xl mb-4">✨</div>
          <h2 className="font-serif text-3xl text-forest mb-2">Order Received!</h2>
          <p className="text-gray-700 mb-2">
            {form.childName ? `${form.childName}'s magical story` : 'Your magical story'} is being created.
          </p>
          <p className="text-sm text-gray-500">Saving your order and sending confirmation…</p>
        </motion.div>
      </main>
    );
  }

  return (
    <main className="w-full min-h-screen bg-cream py-10 px-4">
      <div className="container mx-auto max-w-2xl">

        {/* Nav */}
        <div className="flex items-center justify-between mb-8">
          <Link href="/" className="text-sm text-gray-500 hover:text-forest transition flex items-center gap-1">
            ← Back
          </Link>
          <span className="font-serif font-bold text-forest text-lg">HeroStoryBooks ✨</span>
          <div className="w-12" />
        </div>

        {/* Saved-progress banner */}
        <AnimatePresence>
          {showRecovery && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="mb-6 flex items-center justify-between gap-3 bg-deep-gold/10 border border-deep-gold/30 rounded-xl px-4 py-3 text-sm"
            >
              <span className="text-forest font-medium">✨ We saved your progress — your details are filled in below.</span>
              <button
                onClick={() => { setForm(emptyForm); localStorage.removeItem(STORAGE_KEY); setShowRecovery(false); }}
                className="text-xs text-gray-500 hover:text-forest underline"
              >
                Start fresh
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-10"
        >
          <h1 className="font-serif text-4xl md:text-5xl text-forest mb-3">
            Create Your Story
          </h1>
          <p className="text-gray-600 text-lg">
            Choose the adventure · Tell us about your hero · Add a photo when you&apos;re ready
          </p>
        </motion.div>

        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8 rounded-2xl border border-deep-gold/20 bg-white/90 p-4 shadow-sm"
        >
          <div className="mb-3 flex items-center justify-between text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">
            <span>Checkout progress</span>
            <span>{completedStepCount}/{CHECKOUT_STEPS.length} complete</span>
          </div>
          <Progress value={progressValue} className="h-2.5 bg-gray-100" />
          <div className="mt-4 grid grid-cols-5 gap-2">
            {CHECKOUT_STEPS.map((step, index) => {
              const complete = completedStepCount > index;
              return (
                <div key={step.id} className="text-center">
                  <div className={`mx-auto flex h-8 w-8 items-center justify-center rounded-full border text-xs font-bold ${complete ? 'border-deep-gold bg-deep-gold text-white' : 'border-gray-200 bg-white text-gray-400'}`}>
                    {index + 1}
                  </div>
                  <p className={`mt-2 text-[11px] font-medium ${complete ? 'text-forest' : 'text-gray-400'}`}>{step.label}</p>
                </div>
              );
            })}
          </div>
        </motion.section>

        <form onSubmit={handleSubmit} className="space-y-8">

          {/* ── 1. Theme ── */}
          <section className="bg-white rounded-2xl border-2 border-gray-100 p-6 shadow-sm space-y-4">
            <h2 className="font-serif text-xl text-forest">Choose the adventure</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {THEMES.map(theme => (
                <button
                  key={theme.id}
                  type="button"
                  onClick={() => set('theme', form.theme === theme.id ? '' : theme.id)}
                  className={`
                    flex items-start gap-3 p-4 rounded-xl border-2 text-left transition-all cursor-pointer
                    ${form.theme === theme.id
                      ? 'border-deep-gold bg-deep-gold/8 shadow-sm'
                      : 'border-gray-200 hover:border-gray-300'
                    }
                  `}
                >
                  <span className="text-3xl flex-shrink-0">{theme.emoji}</span>
                  <div>
                    <p className="font-semibold text-forest text-sm">{theme.label}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{theme.desc}</p>
                  </div>
                  {form.theme === theme.id && (
                    <span className="ml-auto text-xs bg-deep-gold text-white font-bold px-2 py-0.5 rounded-full flex-shrink-0">✓</span>
                  )}
                </button>
              ))}
            </div>
          </section>

          {/* ── 2. Child Details ── */}
          <section className="bg-white rounded-2xl border-2 border-gray-100 p-6 shadow-sm space-y-5">
            <h2 className="font-serif text-xl text-forest">About the hero</h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="childName" className="block text-sm font-semibold text-forest mb-1.5">
                  Child&apos;s Name <span className="text-red-400">*</span>
                </label>
                <input
                  id="childName"
                  type="text"
                  value={form.childName}
                  onChange={e => set('childName', e.target.value)}
                  placeholder="e.g., Emma, Liam, Sofia"
                  required
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-deep-gold focus:ring-2 focus:ring-deep-gold/30 transition text-gray-900 bg-white"
                />
              </div>
              <div>
                <label htmlFor="childAge" className="block text-sm font-semibold text-forest mb-1.5">
                  Age <span className="text-gray-400 font-normal">(optional)</span>
                </label>
                <select
                  id="childAge"
                  value={form.childAge}
                  onChange={e => set('childAge', e.target.value)}
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-deep-gold focus:ring-2 focus:ring-deep-gold/30 transition text-gray-900 bg-white"
                >
                  <option value="">Select age</option>
                  {Array.from({ length: 11 }, (_, i) => i + 2).map(age => (
                    <option key={age} value={age}>{age} years old</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-forest mb-2">
                Pronouns <span className="text-red-400">*</span>
              </label>
              <div className="flex flex-wrap gap-2">
                {['she/her', 'he/him', 'they/them'].map(pronouns => (
                  <button
                    key={pronouns}
                    type="button"
                    onClick={() => set('childPronouns', form.childPronouns === pronouns ? '' : pronouns)}
                    className={`px-3 py-2 rounded-full border-2 text-sm font-semibold transition cursor-pointer ${
                      form.childPronouns === pronouns
                        ? 'border-deep-gold bg-deep-gold/10 text-forest'
                        : 'border-gray-200 text-gray-700 hover:border-gray-300'
                    }`}
                  >
                    {pronouns}
                  </button>
                ))}
              </div>
            </div>

            {/* Lesson */}
            <div>
              <label className="block text-sm font-semibold text-forest mb-2">
                Story lesson <span className="text-gray-400 font-normal">(what should the story teach?)</span>
              </label>
              <div className="flex flex-wrap gap-2">
                {LESSONS.map(l => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => set('lesson', form.lesson === l.id ? '' : l.id)}
                    className={`
                      flex items-center gap-1.5 px-3 py-2 rounded-full border-2 text-sm font-semibold transition cursor-pointer
                      ${form.lesson === l.id
                        ? 'border-deep-gold bg-deep-gold/10 text-forest'
                        : 'border-gray-200 text-gray-700 hover:border-gray-300'
                      }
                    `}
                  >
                    <span>{l.emoji}</span>{l.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Occasion */}
            <div>
              <label className="block text-sm font-semibold text-forest mb-2">
                Occasion <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <div className="flex flex-wrap gap-2">
                {OCCASIONS.map(o => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => {
                      const next = form.occasion === o.id ? '' : o.id;
                      setForm(prev => ({ ...prev, occasion: next, giftMessage: next ? prev.giftMessage : '' }));
                    }}
                    className={`
                      px-3 py-2 rounded-full border-2 text-sm font-semibold transition cursor-pointer
                      ${form.occasion === o.id
                        ? 'border-deep-gold bg-deep-gold/10 text-forest'
                        : 'border-gray-200 text-gray-700 hover:border-gray-300'
                      }
                    `}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Gift message — conditional */}
            <AnimatePresence>
              {form.occasion && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                >
                  <label className="block text-sm font-semibold text-forest mb-1.5">
                    Gift message <span className="text-gray-400 font-normal">(printed on the dedication page)</span>
                  </label>
                  <textarea
                    value={form.giftMessage}
                    onChange={e => set('giftMessage', e.target.value)}
                    placeholder={`e.g. "To Emma — may every day be a new adventure. Love, Grandma"`}
                    rows={2}
                    maxLength={200}
                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-deep-gold focus:ring-2 focus:ring-deep-gold/30 transition text-gray-900 bg-white resize-none text-sm"
                  />
                  <p className="text-xs text-gray-400 text-right mt-0.5">{form.giftMessage.length}/200</p>
                </motion.div>
              )}
            </AnimatePresence>
          </section>

          {/* ── 2.5 Character details ── */}
          <section className="bg-white rounded-2xl border-2 border-gray-100 p-6 shadow-sm space-y-4">
            <div>
              <h2 className="font-serif text-xl text-forest mb-1">Character details</h2>
              <p className="text-sm text-gray-500">
                Tell us a few visible details so the art feels more like your child.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-semibold text-forest mb-1.5">Skin tone *</label>
                <select
                  value={form.skinTone}
                  onChange={e => set('skinTone', e.target.value)}
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-deep-gold focus:ring-2 focus:ring-deep-gold/30 transition text-gray-900 bg-white"
                  required
                >
                  <option value="">Select skin tone</option>
                  <option value="fair">Fair</option>
                  <option value="light">Light</option>
                  <option value="medium">Medium</option>
                  <option value="tan">Tan</option>
                  <option value="deep">Deep</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold text-forest mb-1.5">Hair *</label>
                <select
                  value={form.hairStyle}
                  onChange={e => set('hairStyle', e.target.value)}
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-deep-gold focus:ring-2 focus:ring-deep-gold/30 transition text-gray-900 bg-white"
                  required
                >
                  <option value="">Select hair</option>
                  <option value="straight-dark">Straight dark hair</option>
                  <option value="straight-light">Straight light hair</option>
                  <option value="wavy">Wavy hair</option>
                  <option value="curly">Curly hair</option>
                  <option value="coily">Coily hair</option>
                  <option value="short-cropped">Short / cropped</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold text-forest mb-1.5">Glasses or aids</label>
                <select
                  value={form.eyewear}
                  onChange={e => set('eyewear', e.target.value)}
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-deep-gold focus:ring-2 focus:ring-deep-gold/30 transition text-gray-900 bg-white"
                >
                  <option value="">None / not needed</option>
                  <option value="glasses">Glasses</option>
                  <option value="hearing-aid">Hearing aid</option>
                  <option value="mobility-aid">Mobility aid</option>
                  <option value="other">Other visible detail</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm font-semibold text-forest mb-1.5">
                Anything else we should capture? <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <textarea
                value={form.characterNotes}
                onChange={e => set('characterNotes', e.target.value)}
                placeholder="Examples: freckles, favorite hoodie color, wheelchair, curly bangs, hijab, braces..."
                rows={3}
                maxLength={240}
                className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-deep-gold focus:ring-2 focus:ring-deep-gold/30 transition text-gray-900 bg-white resize-none text-sm"
              />
              <p className="text-xs text-gray-400 text-right mt-0.5">{form.characterNotes.length}/240</p>
            </div>
          </section>

          {/* ── 2.6 Supporting characters ── */}
          <section className="bg-white rounded-2xl border-2 border-gray-100 p-6 shadow-sm space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-serif text-xl text-forest mb-1">Family, friends, or pets in the story</h2>
                <p className="text-sm text-gray-500">
                  Optional. If you add a real person, include a reference photo before payment so we do not guess their appearance. Pets can be added without a photo.
                </p>
              </div>
              <button
                type="button"
                onClick={addSupportingCharacter}
                className="shrink-0 rounded-full border-2 border-deep-gold px-3 py-2 text-xs font-bold text-forest hover:bg-deep-gold/10"
              >
                + Add
              </button>
            </div>

            {form.supportingCharacters.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-5 text-center text-sm text-gray-500">
                Add Dad, Grandma, a best friend, or a pet only if they should appear in the story.
              </div>
            ) : (
              <div className="space-y-4">
                {form.supportingCharacters.map((character, index) => (
                  <div key={character.id} className="rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-bold text-forest">Supporting character {index + 1}</p>
                      <button
                        type="button"
                        onClick={() => removeSupportingCharacter(character.id)}
                        className="text-xs text-gray-500 underline hover:text-coral-dark"
                      >
                        Remove
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <input
                        type="text"
                        value={character.name}
                        onChange={e => updateSupportingCharacter(character.id, { name: e.target.value })}
                        placeholder="Name, e.g. Dad or Max"
                        className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-deep-gold focus:ring-2 focus:ring-deep-gold/30 transition text-gray-900 bg-white"
                      />
                      <input
                        type="text"
                        value={character.relationship}
                        onChange={e => updateSupportingCharacter(character.id, { relationship: e.target.value })}
                        placeholder="Relationship, e.g. father, sister, dog"
                        className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-deep-gold focus:ring-2 focus:ring-deep-gold/30 transition text-gray-900 bg-white"
                      />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {(['human', 'pet'] as const).map(kind => (
                        <button
                          key={kind}
                          type="button"
                          onClick={() => updateSupportingCharacter(character.id, { kind, species: kind === 'human' ? '' : character.species })}
                          className={`px-3 py-2 rounded-full border-2 text-xs font-bold uppercase tracking-wide ${
                            character.kind === kind
                              ? 'border-deep-gold bg-deep-gold/10 text-forest'
                              : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'
                          }`}
                        >
                          {kind === 'human' ? 'Person — photo required' : 'Pet — photo optional'}
                        </button>
                      ))}
                    </div>
                    {character.kind === 'pet' && (
                      <input
                        type="text"
                        value={character.species}
                        onChange={e => updateSupportingCharacter(character.id, { species: e.target.value })}
                        placeholder="Pet species, e.g. golden retriever, cat, dragon"
                        className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-deep-gold focus:ring-2 focus:ring-deep-gold/30 transition text-gray-900 bg-white"
                      />
                    )}
                    {character.kind === 'human' && (
                      <div className={`rounded-xl border-2 ${character.photoFile ? 'border-green-200 bg-green-50' : 'border-dashed border-gray-300 bg-white'} p-3`}>
                        <label className="block cursor-pointer">
                          <input
                            type="file"
                            accept="image/*,.heic,.heif"
                            className="hidden"
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) processSupportingPhoto(character.id, f); }}
                          />
                          {character.photoDataUrl ? (
                            <div className="flex items-center gap-3">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={character.photoDataUrl} alt={`${character.name || 'Supporting character'} reference`} className="h-16 w-16 rounded-lg object-cover bg-white" />
                              <div className="text-sm">
                                <p className="font-semibold text-green-700">Reference photo attached</p>
                                <p className="text-xs text-green-600">{character.photoFile?.name}</p>
                              </div>
                            </div>
                          ) : (
                            <div className="text-sm text-gray-500">
                              <span className="font-semibold text-forest">Upload reference photo</span> for this person before payment
                            </div>
                          )}
                        </label>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {missingSupportingHumanPhotos.length > 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                Add reference photo{missingSupportingHumanPhotos.length === 1 ? '' : 's'} for: {missingSupportingHumanPhotos.map(c => c.name || c.relationship || 'supporting character').join(', ')}.
              </div>
            )}
          </section>


          {/* ── 3. Format + Delivery ── */}
          <section className="bg-white rounded-2xl border-2 border-gray-100 p-6 shadow-sm space-y-4">
            <h2 className="font-serif text-xl text-forest">Choose your format</h2>
            <div className="space-y-3">
              {FORMATS.map(fmt => (
                <button
                  key={fmt.id}
                  type="button"
                  onClick={() => set('bookFormat', fmt.id)}
                  className={`
                    w-full flex items-start gap-4 p-4 rounded-xl border-2 text-left transition-all cursor-pointer
                    ${form.bookFormat === fmt.id
                      ? 'border-deep-gold bg-deep-gold/5 shadow-sm'
                      : 'border-gray-200 hover:border-gray-300'
                    }
                  `}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="font-bold text-forest">{fmt.label}</p>
                      {fmt.badge && (
                        <span className="text-xs bg-deep-gold text-white font-bold px-2 py-0.5 rounded-full">{fmt.badge}</span>
                      )}
                    </div>
                    <p className="text-sm text-gray-600">{fmt.delivery}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{fmt.deliveryDetail}</p>
                  </div>
                  <span className="font-bold text-xl text-forest flex-shrink-0">{fmt.price}</span>
                </button>
              ))}
            </div>
          </section>

          {/* ── 4. Email + Preview Promise ── */}
          <section className="bg-white rounded-2xl border-2 border-gray-100 p-6 shadow-sm space-y-4">
            <div>
              <h2 className="font-serif text-xl text-forest mb-1">Where should we send everything?</h2>
              <p className="text-sm text-gray-500">
                We&apos;ll send your confirmation, delivery updates, and any preview approval steps here.
              </p>
            </div>
            <input
              id="email"
              type="email"
              value={form.email}
              onChange={e => set('email', e.target.value)}
              placeholder="your@email.com — for confirmation & delivery"
              required
              className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-deep-gold focus:ring-2 focus:ring-deep-gold/30 transition text-gray-900 bg-white"
            />
            <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800">
              {PRINT_PREVIEW_PROMISE}
            </div>
          </section>

          {/* ── 5. Photo Upload ── */}
          <section className="bg-white rounded-2xl border-2 border-gray-100 p-6 shadow-sm space-y-4">
            <div>
              <h2 className="font-serif text-xl text-forest mb-1">
                Add a photo when you&apos;re ready
              </h2>
              <p className="text-sm text-gray-500">
                AI-assisted illustration uses your photo as a reference. A clearer photo helps — and you review every page in a digital proof before any final PDF or printing.
              </p>
            </div>
            <div className="rounded-xl border border-deep-gold/20 bg-deep-gold/5 px-4 py-3 text-sm text-forest">
              {PHOTO_UPLOAD_HELP}
            </div>

            {/* Sample teaser — shown before upload */}
            {!form.photoDataUrl && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest text-center">
                  What your book looks like
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {SAMPLE_IMAGES.map((src, i) => (
                    <div key={i} className="relative aspect-square rounded-xl overflow-hidden border border-gray-100 bg-gray-50">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={src} alt={`Sample page ${i + 1}`} className="w-full h-full object-cover" />
                      {i === 1 && (
                        <div className="absolute inset-x-0 bottom-2 flex justify-center">
                          <span className="bg-deep-gold/90 text-white text-xs font-bold px-2 py-0.5 rounded-full shadow">
                            Your child here ✨
                          </span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <p className="text-xs text-center text-gray-400">
                  Real AI output · Your child becomes the illustrated hero
                </p>
              </div>
            )}

            {/* Upload zone / preview */}
            {form.photoDataUrl ? (
              <div className="space-y-3">
                <div className="relative rounded-xl overflow-hidden border-2 border-deep-gold shadow-md">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={form.photoDataUrl}
                    alt="Uploaded photo"
                    className="w-full max-h-72 object-contain bg-gray-50"
                  />
                  <div className="absolute inset-0 flex items-end p-3 pointer-events-none">
                    <span className="bg-forest/80 text-white text-xs font-semibold px-3 py-1 rounded-full">
                      ✨ {form.childName ? `${form.childName} becomes` : 'Your child becomes'} the hero
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setForm(prev => ({ ...prev, photoFile: null, photoDataUrl: null })); }}
                    className="absolute top-2 right-2 bg-white/90 hover:bg-white text-forest text-xs font-semibold px-3 py-1.5 rounded-full shadow transition"
                  >
                    Change Photo
                  </button>
                </div>
                <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                  <span>✅</span>
                  <span className="font-medium">{form.photoFile?.name}</span>
                  <span className="text-green-600 text-xs ml-auto">Ready for magic</span>
                </div>
              </div>
            ) : (
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => photoInputRef.current?.click()}
                className={`
                  flex flex-col items-center justify-center gap-3 min-h-40 rounded-xl border-2 border-dashed cursor-pointer transition-all
                  ${dragOver ? 'border-deep-gold bg-deep-gold/5 scale-[1.01]' : 'border-gray-300 hover:border-deep-gold/60 hover:bg-gray-50'}
                `}
              >
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*,.heic,.heif"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) processPhoto(f); }}
                />
                <span className="text-5xl">{dragOver ? '🌟' : '📸'}</span>
                <div className="text-center">
                  <p className="font-semibold text-forest">{dragOver ? 'Drop it here!' : 'Click to Upload'}</p>
                  <p className="text-sm text-gray-400 mt-0.5">or drag &amp; drop · JPG, PNG, WebP, HEIC</p>
                </div>
              </div>
            )}

            <p className="text-xs text-center text-gray-400">
              🔒 Photos processed securely · Used only for your order · Add it later if you need to
            </p>

            {guidedCaptureEnabled && (
              <GuidedPhotoCapture
                heroName={form.childName}
                frames={guidedFrames}
                consent={guidedConsent}
                onConsentChange={setGuidedConsent}
                onFramesChange={setGuidedFrames}
              />
            )}
          </section>

          {VOICE_BETA_ENABLED && (
            <VoiceRecorderSection
              voiceFile={form.voiceFile}
              voicePreviewUrl={form.voicePreviewUrl}
              voiceSource={form.voiceSource}
              voiceConsent={form.voiceConsent}
              onVoiceChange={(file, previewUrl, source) =>
                setForm((prev) => ({
                  ...prev,
                  voiceFile: file,
                  voicePreviewUrl: previewUrl,
                  voiceSource: source,
                  voiceConsent: file ? prev.voiceConsent : false,
                }))
              }
              onConsentChange={(consent) => setForm((prev) => ({ ...prev, voiceConsent: consent }))}
            />
          )}

          {/* ── 6. Order Summary ── */}
          <section className="bg-lavender rounded-2xl border border-gray-200 p-6 shadow-sm">
            <h3 className="font-semibold text-forest mb-4">Order Summary</h3>
            <div className="space-y-2 text-sm text-gray-700">
              {form.theme && (
                <div className="flex justify-between">
                  <span>Adventure</span>
                  <span className="font-medium">{THEMES.find(t => t.id === form.theme)?.emoji} {THEMES.find(t => t.id === form.theme)?.label}</span>
                </div>
              )}
              {form.childName && (
                <div className="flex justify-between">
                  <span>Hero</span>
                  <span className="font-medium">{form.childName}{form.childAge ? `, age ${form.childAge}` : ''}</span>
                </div>
              )}
              {form.lesson && (
                <div className="flex justify-between">
                  <span>Lesson</span>
                  <span className="font-medium">{LESSONS.find(l => l.id === form.lesson)?.emoji} {LESSONS.find(l => l.id === form.lesson)?.label}</span>
                </div>
              )}
              {form.occasion && (
                <div className="flex justify-between">
                  <span>Occasion</span>
                  <span className="font-medium">{OCCASIONS.find(o => o.id === form.occasion)?.label}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span>Format</span>
                <span className="font-medium">{selectedFormat.label}</span>
              </div>
              <div className="mt-2 text-xs text-gray-500 bg-white/60 rounded-lg px-3 py-2">
                {selectedFormat.delivery}
              </div>
              {guidedCaptureEnabled && guidedFrames.length > 0 && (
                <div className="flex justify-between">
                  <span>Guided stills</span>
                  <span className="font-medium">{guidedFrames.length} reference photo{guidedFrames.length === 1 ? '' : 's'}</span>
                </div>
              )}
              {form.supportingCharacters.length > 0 && (
                <div className="flex justify-between">
                  <span>Supporting cast</span>
                  <span className="font-medium">{form.supportingCharacters.length} character{form.supportingCharacters.length === 1 ? '' : 's'}</span>
                </div>
              )}
              {form.bookFormat !== 'digital' && (
                <div className="text-xs text-blue-700 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
                  {PRINT_PREVIEW_PROMISE}
                </div>
              )}
              <div className="flex justify-between pt-3 border-t border-gray-300 mt-2">
                <span className="font-semibold text-base">Total</span>
                <span className="font-bold text-xl text-deep-gold">{selectedFormat.price}</span>
              </div>
            </div>
          </section>

          {/* ── 7. Submit ── */}
          <div className="space-y-3 pb-10">
            <button
              type="submit"
              disabled={isSubmitting || !form.theme || !form.childName || !form.childPronouns || !form.email || !form.skinTone || !form.hairStyle || missingSupportingHumanPhotos.length > 0 || (VOICE_BETA_ENABLED && form.voiceFile != null && !form.voiceConsent)}
              className="w-full py-4 rounded-xl font-bold text-lg transition-all
                bg-deep-gold hover:bg-deep-gold/90 text-white shadow-md hover:shadow-lg hover:-translate-y-0.5
                disabled:opacity-50 disabled:cursor-not-allowed disabled:translate-y-0 disabled:shadow-none"
            >
              {isSubmitting ? '⏳ Processing…' : `Continue to Preview & Payment — ${selectedFormat.price}`}
            </button>
            <p className="text-xs text-center text-gray-400">
              🔒 Secured by Stripe &nbsp;·&nbsp; Print books include proof approval before printing &nbsp;·&nbsp; Your data is never shared
            </p>
          </div>

        </form>
      </div>
    </main>
  );
}
