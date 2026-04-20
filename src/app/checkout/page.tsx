'use client';
import React, { useState, useRef, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';

// ── Constants ──────────────────────────────────────────────────────────────

const THEMES = [
  { id: 'brave-explorer', label: 'Brave Explorer', emoji: '🗺️', desc: 'Jungle adventure & discovery' },
  { id: 'space-voyager',  label: 'Space Voyager',  emoji: '🚀', desc: 'Astronauts & alien planets' },
  { id: 'ocean-dreams',   label: 'Ocean Dreams',   emoji: '🐠', desc: 'Underwater kingdoms & treasure' },
  { id: 'dragon-quest',   label: 'Dragon Quest',   emoji: '🐉', desc: 'Fantasy hero & magical realm' },
  { id: 'royal-adventure',label: 'Royal Adventure',emoji: '👑', desc: 'Prince/Princess & castle quest' },
];

const LESSONS = [
  { id: 'courage',       label: 'Courage',       emoji: '🦁' },
  { id: 'kindness',      label: 'Kindness',       emoji: '💛' },
  { id: 'friendship',    label: 'Friendship',     emoji: '🤝' },
  { id: 'creativity',    label: 'Creativity',     emoji: '🎨' },
  { id: 'perseverance',  label: 'Never Give Up',  emoji: '⭐' },
];

const OCCASIONS = [
  { id: 'birthday',     label: '🎂 Birthday' },
  { id: 'holiday',      label: '🎁 Holiday Gift' },
  { id: 'mothers-day',  label: '💐 Mother\'s Day' },
  { id: 'just-because', label: '❤️ Just Because' },
  { id: 'welcome-baby', label: '🍼 Welcome Baby' },
];

const FORMATS = [
  {
    id: 'digital',
    label: 'Digital',
    icon: '📱',
    price: '$29.99',
    priceNum: 29.99,
    delivery: 'PDF by email in ~15 minutes',
    deliveryDetail: 'Read on any device · Print at home',
  },
  {
    id: 'classic',
    label: 'Classic',
    icon: '📚',
    price: '$49.99',
    priceNum: 49.99,
    badge: 'Most Popular',
    delivery: 'Softcover ships in 5–7 business days',
    deliveryDetail: 'Digital PDF also sent in ~15 min',
  },
  {
    id: 'premium',
    label: 'Premium',
    icon: '⭐',
    price: '$79.99',
    priceNum: 79.99,
    delivery: 'Hardcover ships in 5–7 business days',
    deliveryDetail: 'Digital PDF also sent in ~15 min · 2 extra copies',
  },
];

const STORAGE_KEY = 'hsb_order_v1';
const STORAGE_TTL = 7 * 24 * 60 * 60 * 1000;
const RECOVERY_DEBOUNCE_MS = 1500;

function looksLikeEmail(e: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

const SAMPLE_IMAGES = ['/sample1.png', '/sample2.png', '/sample3.png'];

// ── Types ──────────────────────────────────────────────────────────────────

interface FormState {
  photoFile: File | null;
  photoDataUrl: string | null;
  theme: string;
  childName: string;
  childAge: string;
  lesson: string;
  occasion: string;
  giftMessage: string;
  bookFormat: string;
  email: string;
}

const emptyForm: FormState = {
  photoFile: null,
  photoDataUrl: null,
  theme: '',
  childName: '',
  childAge: '',
  lesson: '',
  occasion: '',
  giftMessage: '',
  bookFormat: 'classic',
  email: '',
};

// ── Helpers ────────────────────────────────────────────────────────────────

function saveProgress(form: FormState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      theme: form.theme,
      childName: form.childName,
      childAge: form.childAge,
      lesson: form.lesson,
      occasion: form.occasion,
      giftMessage: form.giftMessage,
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

// ── Component ──────────────────────────────────────────────────────────────

export default function CheckoutPage() {
  const [form, setForm] = useState<FormState>(emptyForm);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restore saved progress on mount
  useEffect(() => {
    const saved = loadProgress();
    if (saved && (saved.childName || saved.theme)) {
      setShowRecovery(true);
      setForm(prev => ({ ...prev, ...saved }));
    }
  }, []);

  // Auto-save on meaningful changes
  useEffect(() => {
    if (form.childName || form.theme || form.email) {
      saveProgress(form);
    }
  }, [form.theme, form.childName, form.childAge, form.lesson, form.occasion,
      form.giftMessage, form.bookFormat, form.email]);

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
      payload.set('theme', form.theme);
      payload.set('lesson', form.lesson);
      payload.set('occasion', form.occasion);
      payload.set('giftMessage', form.giftMessage);
      payload.set('bookFormat', form.bookFormat);
      payload.set('email', form.email);
      if (form.photoFile) {
        payload.set('photo', form.photoFile);
      }

      const response = await fetch('/api/order', {
        method: 'POST',
        body: payload,
      });

      if (!response.ok) {
        throw new Error('Order submission failed');
      }

      const result = await response.json();
      setSuccess(true);
      localStorage.removeItem(STORAGE_KEY);
      setTimeout(() => {
        window.location.href = result.redirectTo || '/thank-you';
      }, 1200);
    } catch (error) {
      console.error(error);
      alert('We could not save your order. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedFormat = FORMATS.find(f => f.id === form.bookFormat) ?? FORMATS[1];

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
            Upload a photo · Choose the adventure · Your child becomes the hero
          </p>
        </motion.div>

        <form onSubmit={handleSubmit} className="space-y-8">

          {/* ── 1. Photo Upload ── */}
          <section className="bg-white rounded-2xl border-2 border-gray-100 p-6 shadow-sm space-y-4">
            <div>
              <h2 className="font-serif text-xl text-forest mb-1">
                📸 Upload Your Child&apos;s Photo
              </h2>
              <p className="text-sm text-gray-500">
                Our AI places your child&apos;s face into every illustration — the clearer the photo, the better the magic.
              </p>
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
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) processPhoto(f); }}
                />
                <span className="text-5xl">{dragOver ? '🌟' : '📸'}</span>
                <div className="text-center">
                  <p className="font-semibold text-forest">{dragOver ? 'Drop it here!' : 'Click to Upload'}</p>
                  <p className="text-sm text-gray-400 mt-0.5">or drag &amp; drop · JPG, PNG, WebP</p>
                </div>
              </div>
            )}

            <p className="text-xs text-center text-gray-400">
              🔒 Photos processed securely · Never stored after your book is made · 7-day satisfaction guarantee
            </p>
          </section>

          {/* ── 2. Theme ── */}
          <section className="bg-white rounded-2xl border-2 border-gray-100 p-6 shadow-sm space-y-4">
            <h2 className="font-serif text-xl text-forest">🗺️ Choose the Adventure</h2>
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

          {/* ── 3. Child Details ── */}
          <section className="bg-white rounded-2xl border-2 border-gray-100 p-6 shadow-sm space-y-5">
            <h2 className="font-serif text-xl text-forest">👦 About the Hero</h2>

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
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-deep-gold transition text-gray-900 bg-white"
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
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-deep-gold transition text-gray-900 bg-white"
                >
                  <option value="">Select age</option>
                  {Array.from({ length: 11 }, (_, i) => i + 2).map(age => (
                    <option key={age} value={age}>{age} years old</option>
                  ))}
                </select>
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
                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-deep-gold transition text-gray-900 bg-white resize-none text-sm"
                  />
                  <p className="text-xs text-gray-400 text-right mt-0.5">{form.giftMessage.length}/200</p>
                </motion.div>
              )}
            </AnimatePresence>
          </section>

          {/* ── 4. Format + Delivery ── */}
          <section className="bg-white rounded-2xl border-2 border-gray-100 p-6 shadow-sm space-y-4">
            <h2 className="font-serif text-xl text-forest">📦 Choose Your Format</h2>
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
                  <span className="text-3xl flex-shrink-0">{fmt.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="font-bold text-forest">{fmt.label}</p>
                      {fmt.badge && (
                        <span className="text-xs bg-deep-gold text-white font-bold px-2 py-0.5 rounded-full">{fmt.badge}</span>
                      )}
                    </div>
                    <p className="text-sm text-gray-600">⚡ {fmt.delivery}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{fmt.deliveryDetail}</p>
                  </div>
                  <span className="font-bold text-xl text-forest flex-shrink-0">{fmt.price}</span>
                </button>
              ))}
            </div>
          </section>

          {/* ── 5. Email ── */}
          <section className="bg-white rounded-2xl border-2 border-gray-100 p-6 shadow-sm">
            <label htmlFor="email" className="block text-sm font-semibold text-forest mb-1.5">
              Email address <span className="text-red-400">*</span>
            </label>
            <input
              id="email"
              type="email"
              value={form.email}
              onChange={e => set('email', e.target.value)}
              placeholder="your@email.com — for confirmation &amp; delivery"
              required
              className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-deep-gold transition text-gray-900 bg-white"
            />
          </section>

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
                <span className="font-medium">{selectedFormat.icon} {selectedFormat.label}</span>
              </div>
              <div className="flex items-center gap-1.5 mt-2 text-xs text-gray-500 bg-white/60 rounded-lg px-3 py-2">
                <span>⚡</span>
                <span>{selectedFormat.delivery}</span>
              </div>
              {form.bookFormat !== 'digital' && (
                <div className="text-xs text-blue-700 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
                  📱 A digital preview will be emailed first so you can approve before it prints.
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
              disabled={isSubmitting || !form.childName || !form.email}
              className="w-full py-4 rounded-xl font-bold text-lg transition-all
                bg-deep-gold hover:bg-deep-gold/90 text-white shadow-md hover:shadow-lg hover:-translate-y-0.5
                disabled:opacity-50 disabled:cursor-not-allowed disabled:translate-y-0 disabled:shadow-none"
            >
              {isSubmitting ? '⏳ Processing…' : `Continue to Payment — ${selectedFormat.price}`}
            </button>
            <p className="text-xs text-center text-gray-400">
              🔒 Secured by Stripe &nbsp;·&nbsp; 7-day satisfaction guarantee &nbsp;·&nbsp; Your data is never shared
            </p>
          </div>

        </form>
      </div>
    </main>
  );
}
