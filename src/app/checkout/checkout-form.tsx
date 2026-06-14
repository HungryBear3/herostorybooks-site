"use client";
import React, { useState, useRef, useCallback, useEffect } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { Progress } from "@/components/ui/progress";
import { PHOTO_UPLOAD_HELP, PRINT_PREVIEW_PROMISE } from "@/lib/checkout-flow";
import {
  MAX_PHOTO_BYTES,
  compressPhotosForBudget,
  isHeicLikePhoto,
  shouldAutoShrinkPhoto,
  shrinkPhotoForUpload,
} from "@/lib/photo-upload";
import {
  MAX_TOTAL_UPLOAD_BYTES,
  combinedTooLargeMessage,
  estimateTotalUploadBytes,
  formatMb,
  isCombinedUploadTooLarge,
} from "@/lib/upload-limits";
import { VoiceRecorderSection } from "@/components/checkout/VoiceRecorderSection";
import { GuidedPhotoCapture } from "@/components/checkout/GuidedPhotoCapture";
import { StoryPreviewCard } from "@/components/checkout/StoryPreviewCard";
import {
  appendGuidedCaptureToFormData,
  isGuidedPhotoCaptureEnabled,
  type GuidedPhotoFile,
} from "@/lib/guided-photo-capture";
import {
  CHECKOUT_SAMPLE_IMAGES,
  STORY_OCCASIONS,
  STORY_THEMES,
} from "@/lib/story-catalog";
import { getFathersDayCountdown, FATHERS_DAY_OFFER } from "@/lib/fathers-day";
import { track } from "@/lib/analytics";

// ── Constants ──────────────────────────────────────────────────────────────

const LAUNCH_THEME_IDS = new Set([
  "custom-voice-story",
  "brave-explorer",
  "space-voyager",
  "ocean-dreams",
  "dinosaur-discovery",
  "dragon-quest",
  "royal-adventure",
]);

const THEMES = STORY_THEMES.filter((theme) =>
  LAUNCH_THEME_IDS.has(theme.id),
).map((theme) => ({
  id: theme.id,
  label: theme.name,
  emoji: theme.emoji,
  desc: theme.description,
}));

// Map a friendly URL `direction` token to a story-theme id. Entry points
// like NamePreview pass /checkout?direction=dinosaur and we preselect the
// matching launch theme on mount. Unknown directions fall through to an
// empty selection (no surprise preselection).
const DIRECTION_TO_THEME: Record<string, string> = {
  dinosaur: "dinosaur-discovery",
  prehistoric: "dinosaur-discovery",
  space: "space-voyager",
  voyager: "space-voyager",
  ocean: "ocean-dreams",
  dragon: "dragon-quest",
  royal: "royal-adventure",
  explorer: "brave-explorer",
};

function themeIdFromDirection(direction: string | null): string {
  if (!direction) return "";
  const themeId = DIRECTION_TO_THEME[direction.toLowerCase().trim()];
  if (themeId && LAUNCH_THEME_IDS.has(themeId)) return themeId;
  return "";
}

const LESSONS = [
  { id: "courage", label: "Courage", emoji: "🦁" },
  { id: "kindness", label: "Kindness", emoji: "💛" },
  { id: "friendship", label: "Friendship", emoji: "🤝" },
  { id: "creativity", label: "Creativity", emoji: "🎨" },
  { id: "perseverance", label: "Never Give Up", emoji: "⭐" },
];

const OCCASIONS = STORY_OCCASIONS;

const FORMATS = [
  {
    id: "digital",
    label: "Digital PDF",
    icon: "Digital",
    price: "$14.99",
    priceNum: 14.99,
    badge: "Father's Day pick",
    delivery: "We email your digital proof when it's ready — you approve before final delivery",
    deliveryDetail:
      "32-page high-res PDF delivered after you approve · No printing or shipping step",
  },
  {
    id: "classic",
    label: "Classic softcover",
    icon: "Softcover",
    price: "$44.99",
    priceNum: 44.99,
    delivery: "Softcover ships 5–7 business days after proof approval",
    deliveryDetail:
      "32-page softcover · Free US shipping · You approve the proof before print",
  },
  {
    id: "premium",
    label: "Premium hardcover",
    icon: "Hardcover",
    price: "$64.99",
    priceNum: 64.99,
    delivery: "Hardcover ships 5–7 business days after proof approval",
    deliveryDetail:
      "32-page premium hardcover · Free US shipping · You approve the proof before print",
  },
];

const DEFAULT_BOOK_FORMAT = "digital";
const TOTAL_BOOK_PAGE_COUNT = 32;
const ILLUSTRATED_STORY_PAGE_COUNT = 24;

const SUPPORTING_CHARACTER_LIMIT = 4;
const PET_NOTES_PLACEHOLDER = "Breed, color, size, personality, or markings";
const SUPPORTING_CHARACTER_PRESETS = [
  { role: "dad", label: "Dad", relationshipLabel: "Dad", pronouns: "Dad", isGiftRecipient: true },
  { role: "mom", label: "Mom", relationshipLabel: "Mom", pronouns: "Mom", isGiftRecipient: false },
  { role: "sibling", label: "Sibling", relationshipLabel: "sibling", pronouns: "", isGiftRecipient: false },
  { role: "grandparent", label: "Grandparent", relationshipLabel: "grandparent", pronouns: "", isGiftRecipient: false },
  { role: "pet", label: "Dog / pet", relationshipLabel: "family dog", pronouns: "family dog", isGiftRecipient: false },
] as const;

const CHECKOUT_PHOTO_ACCEPT_ATTR = "image/*";

function envFlagEnabled(value: string | undefined): boolean {
  return value?.replace(/\\n/g, "").trim().toLowerCase() === "true";
}

const VOICE_BETA_ENABLED =
  envFlagEnabled(process.env.NEXT_PUBLIC_HSB_VOICE_BETA);
const SPLIT_ASSET_INTAKE_ENABLED =
  envFlagEnabled(process.env.NEXT_PUBLIC_HSB_SPLIT_ASSET_INTAKE);

const STORAGE_KEY = "hsb_order_v1";
const STORAGE_TTL = 7 * 24 * 60 * 60 * 1000;
const RECOVERY_DEBOUNCE_MS = 1500;

function looksLikeEmail(e: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function isAudioInspirationFile(file: File): boolean {
  return file.type.startsWith("audio/") || /\.(webm|m4a|mp3|wav|ogg|oga|aac|caf|aif|aiff|flac|mp4)$/i.test(file.name);
}

const SAMPLE_IMAGES = CHECKOUT_SAMPLE_IMAGES;
const CHECKOUT_STEPS = [
  { id: "theme", label: "Story" },
  { id: "hero", label: "Hero" },
  { id: "format", label: "Format" },
  { id: "email", label: "Email" },
  { id: "photo", label: "Photo" },
];

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
  characterNotes: string;
  familyCharacters: SupportingCharacter[];
  skinTone: string;
  hairStyle: string;
  eyewear: string;
  bookFormat: string;
  email: string;
  voiceFile: File | null;
  voicePreviewUrl: string | null;
  voiceSource: "recorded" | "uploaded" | null;
  voiceConsent: boolean;
}

interface SupportingCharacter {
  id: string;
  role: string;
  name: string;
  relationshipLabel: string;
  pronouns: string;
  notes: string;
  isGiftRecipient: boolean;
  appearsInStory: boolean;
  photoFile: File | null;
  photoDataUrl: string | null;
}

const emptyForm: FormState = {
  photoFile: null,
  photoDataUrl: null,
  theme: "",
  childName: "",
  childAge: "",
  lesson: "",
  occasion: "",
  giftMessage: "",
  characterNotes: "",
  familyCharacters: [],
  skinTone: "",
  hairStyle: "",
  eyewear: "",
  bookFormat: DEFAULT_BOOK_FORMAT,
  email: "",
  voiceFile: null,
  voicePreviewUrl: null,
  voiceSource: null,
  voiceConsent: false,
};

// ── Helpers ────────────────────────────────────────────────────────────────

function saveProgress(form: FormState) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        theme: form.theme,
        childName: form.childName,
        childAge: form.childAge,
        lesson: form.lesson,
        occasion: form.occasion,
        giftMessage: form.giftMessage,
        characterNotes: form.characterNotes,
        familyCharacters: form.familyCharacters,
        skinTone: form.skinTone,
        hairStyle: form.hairStyle,
        eyewear: form.eyewear,
        bookFormat: form.bookFormat,
        email: form.email,
        savedAt: Date.now(),
      }),
    );
  } catch {
    /* localStorage unavailable */
  }
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
  } catch {
    return null;
  }
}

const CHILD_NAME_PARAM_MAX_LEN = 24;
const CHILD_NAME_PARAM_STRIP_PUNCTUATION_RE = /[<>{}`$&;]/g;
const CHILD_NAME_PARAM_STRIP_CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/g;
const NAME_PREVIEW_HANDOFF_KEY = "hsb_name_preview_handoff";

function sanitizeChildNameParam(value: string | null): string {
  return (value ?? "")
    .replace(CHILD_NAME_PARAM_STRIP_PUNCTUATION_RE, "")
    .replace(CHILD_NAME_PARAM_STRIP_CONTROL_CHARS_RE, "")
    .trim()
    .slice(0, CHILD_NAME_PARAM_MAX_LEN);
}

function readNamePreviewHandoff(): { childName: string; direction: string } | null {
  try {
    const raw = window.sessionStorage.getItem(NAME_PREVIEW_HANDOFF_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(NAME_PREVIEW_HANDOFF_KEY);
    const parsed = JSON.parse(raw);
    const childName = sanitizeChildNameParam(
      typeof parsed?.childName === "string" ? parsed.childName : "",
    );
    const direction =
      typeof parsed?.direction === "string" ? parsed.direction.slice(0, 32) : "";
    return childName || direction ? { childName, direction } : null;
  } catch {
    return null;
  }
}

function normalizeBookFormat(value: unknown): string {
  return typeof value === "string" && FORMATS.some((fmt) => fmt.id === value)
    ? value
    : "";
}

function normalizeSavedFamilyCharacters(
  characters: SupportingCharacter[] | undefined,
): SupportingCharacter[] | undefined {
  if (!Array.isArray(characters)) return characters;
  return characters.map((character) => ({
    ...character,
    notes: character.notes === PET_NOTES_PLACEHOLDER ? "" : character.notes,
  }));
}

function checkoutReferralCode(): string {
  const fromUrl = new URLSearchParams(window.location.search).get("ref");
  const fromCookie = document.cookie
    .split("; ")
    .find((row) => row.startsWith("hsb_ref="))
    ?.split("=")[1];
  const raw = fromUrl || (fromCookie ? decodeURIComponent(fromCookie) : "");
  const code = raw.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{1,63}$/.test(code) ? code : "";
}

// ── Component ──────────────────────────────────────────────────────────────

export function CheckoutForm() {
  const [form, setForm] = useState<FormState>(emptyForm);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  // Specific, inline submit error. We use an in-page banner rather than
  // window.alert so the exact server reason is visible/scrollable (alerts get
  // dismissed instantly on mobile) and so we can reassure the customer that no
  // charge was made and nothing was saved when submission fails before Stripe.
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Per-upload size/format errors (resize gate). Main photo + per-character.
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [supportingPhotoErrors, setSupportingPhotoErrors] = useState<Record<string, string>>({});
  const [showRecovery, setShowRecovery] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
  // Guided multi-angle photo capture (feature-flagged). Normal photo upload
  // above remains the always-available path; guided stills are optional extras.
  const guidedCaptureEnabled = isGuidedPhotoCaptureEnabled();
  const [guidedFrames, setGuidedFrames] = useState<GuidedPhotoFile[]>([]);
  const [guidedConsent, setGuidedConsent] = useState(false);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Split-asset pre-upload tracking (NEXT_PUBLIC_HSB_SPLIT_ASSET_INTAKE).
  // uploadedAssetIdsRef memoizes the assetId returned for each File so a retry
  // after a partial failure does NOT re-upload an already-saved file — the
  // server enforces per-category caps and would reject the duplicate, breaking
  // the retry. assetUploadStatuses drives the per-file progress (spinner / check
  // / error + retry) UI.
  //
  // SCOPE (reload-safe dedupe — Part D follow-up): this dedupe is SAME-SESSION
  // ONLY. It keys by the in-memory File object, whose identity is stable across
  // retries within one page session but is gone after a reload. The server does
  // not yet dedupe by a stable localId (see addIntakeAsset TODO in
  // order-intake.ts), so we must NOT promise reload/resume is duplicate-proof in
  // customer-facing copy. On reload the draft id is not persisted, so a fresh
  // submit starts a new draft (no double-charge — payment only happens later at
  // hosted Stripe), at the cost of orphaned, uncharged draft assets.
  const uploadedAssetIdsRef = useRef<Map<File, string>>(new Map());
  // Reuse the same draft + uploaded assets across retries, but only while the
  // selected file set is unchanged. If the customer swaps/removes a file, the
  // signature changes and we start a fresh draft (the server caps each category,
  // so reusing a draft after a file swap would collide).
  const draftOrderIdRef = useRef<string | null>(null);
  const draftSignatureRef = useRef<string>("");
  type AssetUploadStatus = "uploading" | "uploaded" | "error";
  const [assetUploadStatuses, setAssetUploadStatuses] = useState<
    { key: string; label: string; status: AssetUploadStatus }[]
  >([]);
  const setAssetStatus = useCallback(
    (key: string, label: string, status: AssetUploadStatus) => {
      setAssetUploadStatuses((prev) => {
        const next = prev.filter((s) => s.key !== key);
        next.push({ key, label, status });
        return next;
      });
    },
    [],
  );

  // Restore saved progress on mount + honor checkout entry context.
  // NamePreview carries typed names through sessionStorage so a child's name
  // is not put into server-visible query strings. `childName` query support is
  // kept only for backward compatibility with older internal preview links.
  useEffect(() => {
    const saved = loadProgress();
    const params = new URLSearchParams(window.location.search);
    const namePreviewHandoff = readNamePreviewHandoff();
    const formatFromUrl = params.get("format");
    const childNameFromUrl = sanitizeChildNameParam(params.get("childName"));
    const childNameFromHandoff = namePreviewHandoff?.childName ?? "";
    const directionFromUrl = params.get("direction") || namePreviewHandoff?.direction || "";
    const themeFromDirection = themeIdFromDirection(directionFromUrl);
    const nextFormat = normalizeBookFormat(formatFromUrl);
    const savedWithDefaults = saved
      ? {
          ...saved,
          bookFormat: normalizeBookFormat(saved.bookFormat) || DEFAULT_BOOK_FORMAT,
          familyCharacters: normalizeSavedFamilyCharacters(saved.familyCharacters),
        }
      : null;
    const childNamePrefill = childNameFromHandoff || childNameFromUrl;
    const queryPrefill: Partial<FormState> = {
      ...(nextFormat ? { bookFormat: nextFormat } : {}),
      ...(childNamePrefill ? { childName: childNamePrefill } : {}),
      ...(themeFromDirection ? { theme: themeFromDirection } : {}),
    };

    if (savedWithDefaults && (savedWithDefaults.childName || savedWithDefaults.theme)) {
      setShowRecovery(true);
      setForm((prev) => ({ ...prev, ...savedWithDefaults, ...queryPrefill }));
    } else if (nextFormat || childNamePrefill || themeFromDirection) {
      setForm((prev) => ({ ...prev, ...queryPrefill }));
    }

    track("start_checkout", {
      hadSavedProgress: Boolean(saved && (saved.childName || saved.theme)),
      formatFromUrl: nextFormat || null,
      childNameFromUrl: childNameFromUrl ? "yes" : "no",
      childNameFromNamePreview: childNameFromHandoff ? "yes" : "no",
      directionFromUrl: directionFromUrl ? directionFromUrl.slice(0, 32) : null,
      themePreselected: themeFromDirection || null,
    });
  }, []);

  // Auto-save on meaningful changes
  useEffect(() => {
    if (form.childName || form.theme || form.email) {
      saveProgress(form);
    }
  }, [
    form.theme,
    form.childName,
    form.childAge,
    form.lesson,
    form.occasion,
    form.giftMessage,
    form.characterNotes,
    form.familyCharacters,
    form.skinTone,
    form.hairStyle,
    form.eyewear,
    form.bookFormat,
    form.email,
  ]);

  // Server-side recovery capture — debounced, fires when email + any key field is present
  useEffect(() => {
    if (!looksLikeEmail(form.email) || (!form.childName && !form.theme)) return;
    if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
    recoveryTimerRef.current = setTimeout(() => {
      fetch("/api/recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: form.email,
          childName: form.childName || undefined,
          bookFormat: form.bookFormat || undefined,
          theme: form.theme || undefined,
          captureSource: "checkout_form",
        }),
      }).catch(() => {}); // fire-and-forget — never surface errors to the user
    }, RECOVERY_DEBOUNCE_MS);
    return () => {
      if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
    };
  }, [form.email, form.childName, form.bookFormat, form.theme]);

  const set = (key: keyof FormState, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const addSupportingCharacter = (
    preset: (typeof SUPPORTING_CHARACTER_PRESETS)[number],
  ) => {
    setForm((prev) => {
      if (prev.familyCharacters.length >= SUPPORTING_CHARACTER_LIMIT) return prev;
      return {
        ...prev,
        familyCharacters: [
          ...prev.familyCharacters,
          {
            id: `${preset.role}-${Date.now()}-${prev.familyCharacters.length}`,
            role: preset.role,
            name: "",
            relationshipLabel: preset.relationshipLabel,
            pronouns: preset.pronouns,
            notes: "",
            isGiftRecipient: preset.isGiftRecipient,
            appearsInStory: true,
            photoFile: null,
            photoDataUrl: null,
          },
        ],
      };
    });
  };

  const updateSupportingCharacter = (
    id: string,
    patch: Partial<SupportingCharacter>,
  ) => {
    setForm((prev) => ({
      ...prev,
      familyCharacters: prev.familyCharacters.map((character) =>
        character.id === id ? { ...character, ...patch } : character,
      ),
    }));
  };

  const removeSupportingCharacter = (id: string) => {
    setForm((prev) => ({
      ...prev,
      familyCharacters: prev.familyCharacters.filter((character) => character.id !== id),
    }));
  };

  const selectedFormat =
    FORMATS.find((fmt) => fmt.id == form.bookFormat) ?? null;
  const selectedTheme = THEMES.find((theme) => theme.id === form.theme) ?? null;
  const selectedLesson =
    LESSONS.find((lesson) => lesson.id === form.lesson) ?? null;
  const lessonSummary = selectedLesson?.label ?? form.lesson.trim();
  const selectedOccasion =
    OCCASIONS.find((occasion) => occasion.id === form.occasion) ?? null;
  const occasionSummary = selectedOccasion?.label ?? form.occasion.trim();
  const heroName = form.childName || "Your child";
  const printFormat = selectedFormat?.label ?? "Choose a format";
  const totalPrice = selectedFormat ? selectedFormat.price : "—";
  const bookPageCount = TOTAL_BOOK_PAGE_COUNT;
  const illustratedStoryPageCount = ILLUSTRATED_STORY_PAGE_COUNT;
  const coverTitle = selectedTheme
    ? `${heroName}'s ${selectedTheme.label}`
    : "Your Wonderful Story";
  const selectedSampleImage = form.photoDataUrl ?? SAMPLE_IMAGES[0];
  const fathersDay = getFathersDayCountdown();
  const showFathersDayReminder = fathersDay.tier !== "past-event";
  // Email must be a real, deliverable address — not just non-empty. Proof-
  // before-print delivery depends on it, so a malformed address keeps the CTA
  // disabled (matches the server's /api/order email validation).
  const emailLooksValid = looksLikeEmail(form.email);
  const isReadyToPay =
    Boolean(form.theme) &&
    Boolean(form.childName) &&
    Boolean(form.bookFormat) &&
    emailLooksValid &&
    Boolean(form.skinTone) &&
    Boolean(form.hairStyle) &&
    (!VOICE_BETA_ENABLED || form.voiceFile == null || form.voiceConsent);
  const completedStepCount = [
    Boolean(form.theme),
    Boolean(form.childName),
    Boolean(form.bookFormat),
    looksLikeEmail(form.email),
    Boolean(form.photoFile),
  ].filter(Boolean).length;
  const progressValue = (completedStepCount / CHECKOUT_STEPS.length) * 100;

  // Resize JPG/PNG/WebP before storing/submitting; HEIC/HEIF cannot be resized
  // in-browser, so we keep honest behavior: oversized HEIC (or any non-resizable
  // file over the per-photo cap) is rejected with a clear message instead of
  // being silently sent and bounced by Vercel. Returns the prepared (possibly
  // smaller) File, or null with the error already surfaced.
  const preparePhotoFile = useCallback(
    async (file: File, onError: (msg: string) => void): Promise<File | null> => {
      try {
        if (shouldAutoShrinkPhoto(file)) {
          return await shrinkPhotoForUpload(file);
        }
        if (file.size > MAX_PHOTO_BYTES) {
          onError(
            isHeicLikePhoto(file)
              ? `This HEIC photo is ${formatMb(file.size)}. We can't shrink HEIC in the browser — please upload a JPG, PNG, or WebP, or a smaller photo (under ${formatMb(MAX_PHOTO_BYTES)}).`
              : `This photo is ${formatMb(file.size)}, over the ${formatMb(MAX_PHOTO_BYTES)} limit. Please upload a smaller JPG, PNG, or WebP.`,
          );
          return null;
        }
        return file;
      } catch {
        onError(
          `We couldn't process that photo. Please try a different JPG, PNG, or WebP under ${formatMb(MAX_PHOTO_BYTES)}.`,
        );
        return null;
      }
    },
    [],
  );

  const processPhoto = useCallback(
    async (file: File) => {
      setPhotoError(null);
      const prepared = await preparePhotoFile(file, setPhotoError);
      if (!prepared) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        setForm((prev) => ({
          ...prev,
          photoFile: prepared,
          photoDataUrl: e.target?.result as string,
        }));
      };
      reader.readAsDataURL(prepared);
    },
    [preparePhotoFile],
  );

  const processSupportingCharacterPhoto = useCallback(
    async (id: string, file: File) => {
      setSupportingPhotoErrors((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      const prepared = await preparePhotoFile(file, (msg) =>
        setSupportingPhotoErrors((prev) => ({ ...prev, [id]: msg })),
      );
      if (!prepared) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        setForm((prev) => ({
          ...prev,
          familyCharacters: prev.familyCharacters.map((character) =>
            character.id === id
              ? {
                  ...character,
                  photoFile: prepared,
                  photoDataUrl: e.target?.result as string,
                }
              : character,
          ),
        }));
      };
      reader.readAsDataURL(prepared);
    },
    [preparePhotoFile],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith("image/")) processPhoto(file);
    },
    [processPhoto],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setSubmitError(null);

    // Combined-payload guard: estimate total attached bytes and, if over budget,
    // attempt a budget-aware recompression of all resizable photos before
    // surfacing an error. This handles the common case where individually-valid
    // photos + a voice note collectively exceed Vercel's ~4.5 MB request limit.
    const voiceBytes = VOICE_BETA_ENABLED && form.voiceFile ? form.voiceFile.size : 0;
    let resolvedPhotoFile = form.photoFile;
    let resolvedCharacters = form.familyCharacters;

    const totalUploadBytes = estimateTotalUploadBytes({
      mainPhotoBytes: resolvedPhotoFile?.size ?? 0,
      supportingPhotoBytes: resolvedCharacters.map((c) => c.photoFile?.size ?? 0).filter((n) => n > 0),
      voiceBytes,
    });

    if (isCombinedUploadTooLarge(totalUploadBytes)) {
      // Collect all photo files, compress to fit the photo budget, then
      // redistribute back into form state for this submission only.
      const allPhotos: File[] = [
        ...(resolvedPhotoFile ? [resolvedPhotoFile] : []),
        ...resolvedCharacters.map((c) => c.photoFile).filter((f): f is File => f != null),
      ];
      const photoBudget = MAX_TOTAL_UPLOAD_BYTES - voiceBytes;
      try {
        const recompressed = await compressPhotosForBudget(allPhotos, photoBudget);
        let recompIdx = 0;
        resolvedPhotoFile = resolvedPhotoFile ? recompressed[recompIdx++] : resolvedPhotoFile;
        resolvedCharacters = resolvedCharacters.map((c) =>
          c.photoFile ? { ...c, photoFile: recompressed[recompIdx++] } : c,
        );
      } catch {
        // Compression failed — fall through to the size error below.
      }

      const retotalBytes = estimateTotalUploadBytes({
        mainPhotoBytes: resolvedPhotoFile?.size ?? 0,
        supportingPhotoBytes: resolvedCharacters.map((c) => c.photoFile?.size ?? 0).filter((n) => n > 0),
        voiceBytes,
      });
      if (isCombinedUploadTooLarge(retotalBytes)) {
        setSubmitError(combinedTooLargeMessage(retotalBytes));
        setIsSubmitting(false);
        return;
      }
    }

    // Fire BOTH the brief's "purchase_intent" alias and the more literal
    // "order_submit_attempt" so downstream funnels can use either name.
    // Network round-trip + payment success/failure live further along the
    // pipeline; this event captures intent, not completion.
    const attemptProps = {
      theme: form.theme || null,
      bookFormat: form.bookFormat || null,
      hasPhoto: form.photoFile != null,
      hasVoice: form.voiceFile != null,
      familyCharacterCount: form.familyCharacters.length,
    };
    track("order_submit_attempt", attemptProps);
    track("purchase_intent", attemptProps);
    if (recoveryTimerRef.current) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }

    try {
      const payload = new FormData();
      const familyCharactersForOrder = resolvedCharacters
        .filter((character) =>
          Boolean(
            character.name.trim() ||
              character.relationshipLabel.trim() ||
              character.notes.trim() ||
              character.photoFile,
          ),
        )
        .slice(0, SUPPORTING_CHARACTER_LIMIT);

      if (SPLIT_ASSET_INTAKE_ENABLED) {
        setSubmitError("Saving your photos and story details securely before payment… You have not been charged yet.");
        setAssetUploadStatuses([]);
        const familyCharactersJson = familyCharactersForOrder.map((character) => ({
          role: character.role,
          name: character.name,
          relationshipLabel: character.relationshipLabel,
          pronouns: character.pronouns,
          notes: character.notes,
          isGiftRecipient: character.isGiftRecipient,
          appearsInStory: character.appearsInStory,
          photoFileName: character.photoFile?.name ?? null,
        }));

        // Signature of the selected file set. A retry with the SAME files reuses
        // the existing draft + already-uploaded assets (idempotent). If any file
        // changed, the signature differs and we start a fresh draft so the
        // server's per-category caps can't collide with a swapped file.
        const sig = (f: File | null | undefined) => (f ? `${f.name}:${f.size}` : "-");
        const fileSignature = [
          sig(resolvedPhotoFile),
          ...guidedFrames.map((g) => sig(g.file)),
          ...familyCharactersForOrder.map((c) => sig(c.photoFile)),
          sig(VOICE_BETA_ENABLED ? form.voiceFile : null),
        ].join("|");

        let draftOrderId = draftOrderIdRef.current;
        if (!draftOrderId || draftSignatureRef.current !== fileSignature) {
          // Starting a fresh draft: drop any cached assetIds from a prior draft.
          uploadedAssetIdsRef.current = new Map();
          const draftResponse = await fetch("/api/order/draft", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              childName: form.childName,
              childAge: form.childAge,
              theme: form.theme,
              lesson: form.lesson,
              occasion: form.occasion,
              giftMessage: form.giftMessage,
              characterNotes: form.characterNotes,
              familyCharacters: familyCharactersJson,
              appearanceOptions: JSON.stringify({
                skinTone: form.skinTone,
                hairStyle: form.hairStyle,
                eyewear: form.eyewear,
              }),
              skinTone: form.skinTone,
              hairStyle: form.hairStyle,
              bookFormat: form.bookFormat,
              email: form.email,
              referralCode: checkoutReferralCode(),
            }),
          });
          const draftBody = await draftResponse.json().catch(() => null);
          if (!draftResponse.ok || !draftBody?.draftOrderId) {
            throw new Error(draftBody?.error || "We couldn't securely save your order draft. You have not been charged.");
          }
          draftOrderId = String(draftBody.draftOrderId);
          draftOrderIdRef.current = draftOrderId;
          draftSignatureRef.current = fileSignature;
        }
        // Idempotent per-file upload. If this File was already uploaded in a
        // prior submit attempt, reuse its assetId and skip the network call —
        // the server caps each category, so re-uploading would 4xx and break a
        // retry. Each call reports its status for the per-file progress UI.
        const uploadOneAsset = async (
          label: string,
          category: string,
          file: File,
          extra: Record<string, string> = {},
        ) => {
          const statusKey = `${category}:${file.name}:${file.size}`;
          const cached = uploadedAssetIdsRef.current.get(file);
          if (cached) {
            setAssetStatus(statusKey, label, "uploaded");
            return cached;
          }
          setAssetStatus(statusKey, label, "uploading");
          const assetPayload = new FormData();
          assetPayload.set("category", category);
          assetPayload.set("label", label);
          assetPayload.set("file", file, file.name);
          // Stable per-file id so the server can dedupe a reload/resume or
          // lost-response retry (returns the existing asset instead of a copy).
          assetPayload.set("localId", `${file.name}|${file.size}|${file.lastModified}`);
          for (const [key, value] of Object.entries(extra)) assetPayload.set(key, value);
          let response: Response;
          try {
            response = await fetch(`/api/order/draft/${draftOrderId}/assets`, {
              method: "POST",
              body: assetPayload,
            });
          } catch (networkError) {
            setAssetStatus(statusKey, label, "error");
            throw networkError;
          }
          const body = await response.json().catch(() => null);
          if (!response.ok || !body?.asset?.assetId) {
            setAssetStatus(statusKey, label, "error");
            throw new Error(
              body?.error ||
                `We couldn't securely save ${label}. You have not been charged. Please retry or remove that file.`,
            );
          }
          const assetId = String(body.asset.assetId);
          uploadedAssetIdsRef.current.set(file, assetId);
          setAssetStatus(statusKey, label, "uploaded");
          return assetId;
        };

        const primaryPhotoAssetId = resolvedPhotoFile
          ? await uploadOneAsset("child reference photo", "primary_photo", resolvedPhotoFile)
          : null;
        const guidedChildReferenceAssetIds: string[] = [];
        if (guidedCaptureEnabled && guidedConsent && guidedFrames.length > 0) {
          for (const frame of guidedFrames) {
            guidedChildReferenceAssetIds.push(
              await uploadOneAsset(`guided ${frame.label} reference photo`, "guided_child_reference", frame.file, {
                source: "guided_capture",
                label: String(frame.label),
                guidedPhotoConsent: "true",
              }),
            );
          }
        }
        for (const [index, character] of familyCharactersForOrder.entries()) {
          if (character.photoFile) {
            await uploadOneAsset(`${character.relationshipLabel || character.name || "family"} reference photo`, "supporting_character_reference", character.photoFile, {
              familyCharacterIndex: String(index),
              familyCharacterId: `family-${index}`,
            });
          }
        }
        const voiceAssetId = VOICE_BETA_ENABLED && form.voiceFile && isAudioInspirationFile(form.voiceFile)
          ? await uploadOneAsset("story inspiration", "voice_inspiration", form.voiceFile, {
              source: form.voiceSource === "recorded" ? "recorded" : "upload",
              voiceConsent: form.voiceConsent ? "true" : "false",
            })
          : null;
        const documentAssetIds = VOICE_BETA_ENABLED && form.voiceFile && !isAudioInspirationFile(form.voiceFile)
          ? [await uploadOneAsset("story inspiration", "document_inspiration", form.voiceFile, {
              source: "upload",
              voiceConsent: form.voiceConsent ? "true" : "false",
            })]
          : [];
        const finalizeResponse = await fetch("/api/order/finalize", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            draftOrderId,
            primaryPhotoAssetId,
            guidedChildReferenceAssetIds,
            voiceAssetId,
            documentAssetIds,
            finalConsent: { photos: true, voice: form.voiceConsent, terms: true },
            fields: {
              childName: form.childName,
              childAge: form.childAge,
              theme: form.theme,
              lesson: form.lesson,
              occasion: form.occasion,
              giftMessage: form.giftMessage,
              characterNotes: form.characterNotes,
              familyCharacters: familyCharactersJson,
              appearanceOptions: JSON.stringify({
                skinTone: form.skinTone,
                hairStyle: form.hairStyle,
                eyewear: form.eyewear,
              }),
              bookFormat: form.bookFormat,
              email: form.email,
              referralCode: checkoutReferralCode(),
            },
          }),
        });
        const result = await finalizeResponse.json().catch(() => null);
        if (!finalizeResponse.ok || !result?.redirectTo) {
          throw new Error(result?.error || "We couldn't securely finalize your order. You have not been charged.");
        }
        setSubmitError(null);
        setSuccess(true);
        localStorage.removeItem(STORAGE_KEY);
        setTimeout(() => {
          window.location.href = result.redirectTo;
        }, 1200);
        return;
      }

      payload.set("childName", form.childName);
      payload.set("childAge", form.childAge);
      payload.set("theme", form.theme);
      payload.set("lesson", form.lesson);
      payload.set("occasion", form.occasion);
      payload.set("giftMessage", form.giftMessage);
      payload.set("characterNotes", form.characterNotes);
      payload.set(
        "familyCharacters",
        JSON.stringify(
          familyCharactersForOrder
            .map((character) => ({
              role: character.role,
              name: character.name,
              relationshipLabel: character.relationshipLabel,
              pronouns: character.pronouns,
              notes: character.notes,
              isGiftRecipient: character.isGiftRecipient,
              appearsInStory: character.appearsInStory,
              photoFileName: character.photoFile?.name ?? null,
            })),
        ),
      );
      familyCharactersForOrder.forEach((character, index) => {
        if (character.photoFile) {
          payload.set(`familyCharacterPhoto_${index}`, character.photoFile);
        }
      });
      payload.set(
        "appearanceOptions",
        JSON.stringify({
          skinTone: form.skinTone,
          hairStyle: form.hairStyle,
          eyewear: form.eyewear,
        }),
      );
      payload.set("bookFormat", form.bookFormat);
      payload.set("email", form.email);
      const referralCode = checkoutReferralCode();
      if (referralCode) payload.set("referralCode", referralCode);
      if (resolvedPhotoFile) {
        payload.set("photo", resolvedPhotoFile);
      }
      if (VOICE_BETA_ENABLED && form.voiceFile) {
        payload.set("voice", form.voiceFile);
        payload.set("voiceConsent", form.voiceConsent ? "true" : "false");
        if (form.voiceSource) payload.set("voiceSource", form.voiceSource);
      }
      // Guided reference stills (flag-gated). Appends guidedPhoto_i + labels +
      // version + consent for approved still frames only — never video.
      if (guidedCaptureEnabled && guidedConsent && guidedFrames.length > 0) {
        appendGuidedCaptureToFormData(payload, guidedFrames);
      }

      const response = await fetch("/api/order", {
        method: "POST",
        body: payload,
      });

      if (!response.ok) {
        // Surface the server's SPECIFIC reason (e.g. the voice-save abort)
        // rather than a generic message, so the customer knows exactly what
        // failed and — critically — that nothing was saved or charged.
        let message =
          "We couldn't start your order. You have not been charged. Please try again.";
        try {
          const body = await response.json();
          if (typeof body?.error === "string" && body.error.trim()) {
            message = body.error;
          }
        } catch {
          /* non-JSON response — keep the safe default */
        }
        throw new Error(message);
      }

      const result = await response.json();
      // Only reached when the order was durably persisted AND a Stripe session
      // was created. We are about to redirect to PAYMENT — do not claim the
      // order/recording is finished here (see the interstitial copy below).
      if (!result?.redirectTo) {
        throw new Error(
          "We couldn't reach secure payment. You have not been charged. Please try again.",
        );
      }
      setSuccess(true);
      localStorage.removeItem(STORAGE_KEY);
      setTimeout(() => {
        window.location.href = result.redirectTo;
      }, 1200);
    } catch (error) {
      console.error(error);
      // Inline banner instead of window.alert — see submitError declaration.
      setSubmitError(
        error instanceof Error
          ? error.message
          : "We couldn't start your order. You have not been charged. Please try again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  if (success) {
    return (
      <main className="min-h-screen bg-cream flex items-center justify-center px-4 text-[#1f1a16]">
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          className="rounded-[2rem] border border-[#d8c6a2] bg-[#fff8ec] p-12 text-center max-w-md w-full shadow-[0_28px_80px_-55px_rgba(31,26,22,0.55)]"
        >
          <div className="text-6xl mb-4">✨</div>
          <h2 className="font-serif text-3xl text-forest mb-2">
            Taking you to secure payment…
          </h2>
          <p className="text-[#695f54] mb-2">
            Your files are saved for{" "}
            {form.childName
              ? `${form.childName}'s custom story`
              : "your custom story"}
            . Next you&apos;ll review payment in Stripe — nothing is charged
            until you complete it there.
          </p>
          <p className="text-sm text-[#695f54]">
            Redirecting to Stripe… please don&apos;t close this tab.
          </p>
        </motion.div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#f4ecd9] text-[#241914]">
      <div className="border-b border-[#ded0b3] bg-[#f4ecd9]/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <Link
            href="/"
            className="flex min-w-0 items-center gap-2 font-serif text-[13px] font-semibold uppercase tracking-[0.18em] text-[#241914] sm:text-base sm:tracking-[0.28em]"
          >
            <span className="h-2 w-2 flex-shrink-0 rounded-full bg-[#a64c4c]" />
            <span className="truncate">HeroStoryBooks</span>
          </Link>
          {/* Hide the secondary badge below sm: brand text needs the full row
              on narrow phones (≤ ~380px) or the truncate-ellipsis trims it. */}
          <span className="hidden items-center gap-1.5 text-xs text-[#6e6154] sm:flex">
            <span aria-hidden="true">⌘</span> Secure checkout
          </span>
        </div>
      </div>

      <div className="border-b border-[#ded0b3] bg-[#efe3ca]">
        <div className="mx-auto flex max-w-xl items-center justify-center gap-3 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8c7b68] sm:gap-5">
          {["Review", "Details", "Pay"].map((step, index) => {
            const active = index === 1;
            const done = index === 0;
            return (
              <React.Fragment key={step}>
                <span
                  className={`flex items-center gap-2 ${active ? "text-deep-gold" : done ? "text-[#241914]" : "text-[#9f927f]"}`}
                >
                  <span
                    className={`flex h-5 w-5 items-center justify-center rounded-full border text-[10px] ${done ? "border-deep-gold bg-deep-gold text-navy" : active ? "border-deep-gold bg-cream text-deep-gold" : "border-[#cbbda4] bg-[#f8f0dd] text-[#9f927f]"}`}
                  >
                    {done ? "✓" : index + 1}
                  </span>
                  {step}
                </span>
                {index < 2 && <span className="h-px w-8 bg-[#cbbda4]" />}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:py-10">
        <AnimatePresence>
          {showRecovery && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="mb-6 flex items-center justify-between gap-3 rounded-2xl border border-[#a64c4c]/30 bg-[#a64c4c]/10 px-4 py-3 text-sm"
            >
              <span className="font-medium text-[#241914]">
                We saved your progress — your details are filled in below.
              </span>
              <button
                onClick={() => {
                  setForm(emptyForm);
                  localStorage.removeItem(STORAGE_KEY);
                  setShowRecovery(false);
                }}
                className="text-xs text-[#6e6154] underline hover:text-[#241914]"
              >
                Start fresh
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        <form
          onSubmit={handleSubmit}
          className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_340px]"
        >
          <div className="space-y-5">
            {/* ── 1. Theme ── */}
            <section className="rounded-[1.75rem] border border-[#d8c6a2] bg-[#fff8ec] p-6 shadow-[0_18px_50px_-44px_rgba(31,26,22,0.5)] space-y-4">
              <h2 className="font-serif text-2xl text-[#1f1a16]">
                Choose a story direction
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {THEMES.map((theme) => (
                  <button
                    key={theme.id}
                    type="button"
                    onClick={() => {
                      const next = form.theme === theme.id ? "" : theme.id;
                      set("theme", next);
                      if (next) track("story_selected", { theme: next });
                    }}
                    className={`
                    flex items-start gap-3 p-4 rounded-2xl border-2 text-left transition-all cursor-pointer
                    ${
                      form.theme === theme.id
                        ? "border-deep-gold bg-deep-gold/15 ring-2 ring-deep-gold/30 shadow-sm"
                        : "border-[#dfd2b8] hover:border-[#d8c6a2]"
                    }
                  `}
                  >
                    <span className="text-3xl flex-shrink-0">
                      {theme.emoji}
                    </span>
                    <div>
                      <p className="font-semibold text-[#1f1a16] text-sm">
                        {theme.label}
                      </p>
                      <p className="text-xs text-[#695f54] mt-0.5">
                        {theme.desc}
                      </p>
                    </div>
                    {form.theme === theme.id && (
                      <span className="ml-auto text-xs bg-deep-gold text-navy font-bold px-2 py-0.5 rounded-full flex-shrink-0">
                        ✓
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </section>

            {/* ── 2. Child Details ── */}
            <section className="rounded-[1.75rem] border border-[#d8c6a2] bg-[#fff8ec] p-6 shadow-[0_18px_50px_-44px_rgba(31,26,22,0.5)] space-y-5">
              <h2 className="font-serif text-2xl text-[#1f1a16]">
                About the hero
              </h2>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="childName"
                    className="block text-sm font-semibold text-[#1f1a16] mb-1.5"
                  >
                    Child&apos;s Name <span className="text-red-400">*</span>
                  </label>
                  <input
                    id="childName"
                    type="text"
                    value={form.childName}
                    onChange={(e) => set("childName", e.target.value)}
                    placeholder="e.g., Emma, Liam, Sofia"
                    required
                    className="w-full px-4 py-3 border-2 border-[#dfd2b8] rounded-2xl focus:outline-none focus:border-[#a64c4c] focus:ring-2 focus:ring-[#a64c4c]/30 transition text-[#1f1a16] bg-[#fffaf1]"
                  />
                </div>
                <div>
                  <label
                    htmlFor="childAge"
                    className="block text-sm font-semibold text-[#1f1a16] mb-1.5"
                  >
                    Age{" "}
                    <span className="text-[#8a7b6a] font-normal">
                      (optional)
                    </span>
                  </label>
                  <select
                    id="childAge"
                    value={form.childAge}
                    onChange={(e) => set("childAge", e.target.value)}
                    className="w-full px-4 py-3 border-2 border-[#dfd2b8] rounded-2xl focus:outline-none focus:border-[#a64c4c] focus:ring-2 focus:ring-[#a64c4c]/30 transition text-[#1f1a16] bg-[#fffaf1]"
                  >
                    <option value="">Select age</option>
                    {Array.from({ length: 11 }, (_, i) => i + 2).map((age) => (
                      <option key={age} value={age}>
                        {age} years old
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </section>

            {/* ── 2.4 Who's in the story? — hero photo (moved above family
                   members per 2026-06-09 checkout UX review) ── */}
            <section className="rounded-[1.75rem] border border-[#d8c6a2] bg-[#fff8ec] p-6 shadow-[0_18px_50px_-44px_rgba(31,26,22,0.5)] space-y-4">
              <div>
                <h2 className="font-serif text-2xl text-[#1f1a16] mb-1">
                  Who&apos;s in the story?
                </h2>
                <p className="text-sm text-[#695f54]">
                  Add still reference photos so we can illustrate your family
                  more consistently. You control every photo: use camera,
                  upload, retake, or remove before checkout.
                </p>
                <p className="mt-1 text-xs leading-5 text-[#8a7b6a]">
                  Still photos only — never video. These are private reference
                  photos for your book.
                </p>
              </div>

              <div className="rounded-2xl border border-[#dfd2b8] bg-[#fffaf1] p-4 space-y-4">
                <div>
                  <p className="text-sm font-bold text-[#1f1a16]">
                    {form.childName
                      ? `${form.childName} — the hero`
                      : "Your child — the hero"}
                  </p>
                  <p className="text-sm text-[#695f54]">
                    Add a still reference photo for {form.childName || "your child"} — we&apos;ll
                    draw them as the hero. Use your camera or upload one you
                    already have, then we hand-review the proof before anything
                    prints.
                  </p>
                </div>
                <div className="rounded-2xl border border-[#a64c4c]/20 bg-[#a64c4c]/10 px-4 py-3 text-sm text-[#1f1a16]">
                  {PHOTO_UPLOAD_HELP}
                </div>

                {/* Sample teaser — shown before a photo is added */}
                {!form.photoDataUrl && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-[#8a7b6a] uppercase tracking-widest text-center">
                      What your proof includes
                    </p>
                    <div className="grid gap-2 sm:grid-cols-[0.85fr_1.15fr]">
                      <div className="overflow-hidden rounded-2xl border border-[#dfd2b8] bg-[#f5ead2]">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src="/assets/real-photo-demo.png"
                          alt="Example reference photo used for a personalized book"
                          className="h-40 w-full object-cover sm:h-full"
                        />
                        <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-[0.16em] text-[#695f54]">
                          Uploaded photo
                        </div>
                      </div>
                      <div className="overflow-hidden rounded-2xl border border-[#dfd2b8] bg-[#f5ead2]">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src="/assets/storybook-transform-demo.png"
                          alt="Example storybook illustration created from the uploaded photo"
                          className="h-40 w-full object-cover sm:h-full"
                        />
                        <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-[0.16em] text-[#695f54]">
                          Illustration proof
                        </div>
                      </div>
                    </div>
                    <p className="text-xs text-center text-[#8a7b6a]">
                      Uploaded photo → storybook illustration · hand-reviewed
                      before print
                    </p>
                  </div>
                )}

                {/* Upload/camera zone or preview */}
                {form.photoDataUrl ? (
                  <div className="space-y-3">
                    <div className="relative rounded-2xl overflow-hidden border-2 border-[#a64c4c] shadow-md">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={form.photoDataUrl}
                        alt="Uploaded photo"
                        className="w-full max-h-72 object-contain bg-[#f5ead2]"
                      />
                      <div className="absolute inset-0 flex items-end p-3 pointer-events-none">
                        <span className="bg-[#1f1a16]/80 text-white text-xs font-semibold px-3 py-1 rounded-full">
                          ✨{" "}
                          {form.childName
                            ? `${form.childName} becomes`
                            : "Your child becomes"}{" "}
                          the hero
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setForm((prev) => ({
                            ...prev,
                            photoFile: null,
                            photoDataUrl: null,
                          }));
                        }}
                        className="absolute top-2 right-2 bg-[#fffaf1]/90 hover:bg-[#fffaf1] text-[#1f1a16] text-xs font-semibold px-3 py-1.5 rounded-full shadow transition"
                      >
                        Retake or remove
                      </button>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-[#35564d] bg-[#eef4f1] border border-[#cfe0d8] rounded-lg px-3 py-2">
                      <span>✅</span>
                      <span className="font-medium">{form.photoFile?.name}</span>
                      <span className="text-[#35564d] text-xs ml-auto">
                        Ready for proof
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {/* Two ways to add the hero photo: camera (capture attr opens
                        the camera on mobile) or upload from the library. Both
                        reuse the existing processPhoto handler. */}
                    <div className="flex flex-wrap gap-2">
                      <label className="flex cursor-pointer items-center gap-1.5 rounded-full bg-[#1f1a16] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#3b3029]">
                        Use camera
                        <input
                          type="file"
                          accept={CHECKOUT_PHOTO_ACCEPT_ATTR}
                          capture="user"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) processPhoto(f);
                            e.currentTarget.value = "";
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => photoInputRef.current?.click()}
                        className="flex items-center gap-1.5 rounded-full border-2 border-[#dfd2b8] px-4 py-2 text-sm font-semibold text-[#695f54] transition hover:border-[#a64c4c]/60 hover:bg-[#f5ead2]"
                      >
                        Upload photo
                      </button>
                    </div>
                    <div
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragOver(true);
                      }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={handleDrop}
                      onClick={() => photoInputRef.current?.click()}
                      className={`
                      flex flex-col items-center justify-center gap-3 min-h-40 rounded-2xl border-2 border-dashed cursor-pointer transition-all
                      ${dragOver ? "border-[#a64c4c] bg-[#a64c4c]/10 scale-[1.01]" : "border-[#d8c6a2] hover:border-[#a64c4c]/60 hover:bg-[#f5ead2]"}
                    `}
                    >
                      <input
                        ref={photoInputRef}
                        type="file"
                        accept={CHECKOUT_PHOTO_ACCEPT_ATTR}
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) processPhoto(f);
                        }}
                      />
                      <span className="text-5xl">{dragOver ? "🌟" : "📸"}</span>
                      <div className="text-center">
                        <p className="font-semibold text-[#1f1a16]">
                          {dragOver ? "Drop it here!" : "Take a photo or upload one"}
                        </p>
                        <p className="mt-0.5 px-2 text-sm leading-5 text-[#8a7b6a]">
                          or drag &amp; drop · JPG/PNG/WebP/HEIC
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {photoError && (
                  <p role="alert" className="text-sm font-medium text-[#8a2f2f]">
                    {photoError}
                  </p>
                )}
                <p className="text-xs text-center text-[#8a7b6a]">
                  🔒 Photos processed securely · Used only for your order · Add it
                  later if you need to
                </p>
              </div>

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

            {/* ── 2.5 Story details ── */}
            <section className="rounded-[1.75rem] border border-[#d8c6a2] bg-[#fff8ec] p-6 shadow-[0_18px_50px_-44px_rgba(31,26,22,0.5)] space-y-5">
              {/* Lesson */}
              <div>
                <label className="block text-sm font-semibold text-[#1f1a16] mb-2">
                  Story lesson{" "}
                  <span className="text-[#8a7b6a] font-normal">
                    (what should the story teach?)
                  </span>
                </label>
                <div className="flex flex-wrap gap-2">
                  {LESSONS.map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() =>
                        set("lesson", form.lesson === l.id ? "" : l.id)
                      }
                      className={`
                      flex items-center gap-1.5 px-3 py-2 rounded-full border-2 text-sm font-semibold transition cursor-pointer
                      ${
                        form.lesson === l.id
                          ? "border-deep-gold bg-deep-gold/15 ring-2 ring-deep-gold/30 text-navy"
                          : "border-[#dfd2b8] text-[#695f54] hover:border-[#d8c6a2]"
                      }
                    `}
                    >
                      <span>{l.emoji}</span>
                      {l.label}
                    </button>
                  ))}
                </div>
                <label
                  htmlFor="customLesson"
                  className="mt-4 block text-xs font-semibold uppercase tracking-[0.16em] text-[#8a7663]"
                >
                  Custom story lesson
                </label>
                <input
                  id="customLesson"
                  type="text"
                  value={selectedLesson ? "" : form.lesson}
                  onChange={(e) => set("lesson", e.target.value.slice(0, 80))}
                  placeholder="e.g. Dad always comes home, sharing bravely, asking for help"
                  className="mt-2 w-full rounded-2xl border-2 border-[#dfd2b8] bg-[#fffaf1] px-4 py-3 text-sm text-[#1f1a16] transition placeholder:text-[#9a8b7a] focus:border-[#a64c4c] focus:outline-none focus:ring-2 focus:ring-[#a64c4c]/30"
                />
              </div>

              {/* Occasion */}
              <div>
                <label className="block text-sm font-semibold text-[#1f1a16] mb-2">
                  Occasion{" "}
                  <span className="text-[#8a7b6a] font-normal">(optional)</span>
                </label>
                <div className="flex flex-wrap gap-2">
                  {OCCASIONS.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => {
                        const next = form.occasion === o.id ? "" : o.id;
                        setForm((prev) => ({
                          ...prev,
                          occasion: next,
                          giftMessage: next ? prev.giftMessage : "",
                        }));
                      }}
                      className={`
                      px-3 py-2 rounded-full border-2 text-sm font-semibold transition cursor-pointer
                      ${
                        form.occasion === o.id
                          ? "border-deep-gold bg-deep-gold/15 ring-2 ring-deep-gold/30 text-navy"
                          : "border-[#dfd2b8] text-[#695f54] hover:border-[#d8c6a2]"
                      }
                    `}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                <label
                  htmlFor="customOccasion"
                  className="mt-4 block text-xs font-semibold uppercase tracking-[0.16em] text-[#8a7663]"
                >
                  Custom occasion
                </label>
                <input
                  id="customOccasion"
                  type="text"
                  value={selectedOccasion ? "" : form.occasion}
                  onChange={(e) => {
                    const next = e.target.value.slice(0, 80);
                    setForm((prev) => ({
                      ...prev,
                      occasion: next,
                    }));
                  }}
                  placeholder="e.g. Father's Day, first day of school, big sibling gift"
                  className="mt-2 w-full rounded-2xl border-2 border-[#dfd2b8] bg-[#fffaf1] px-4 py-3 text-sm text-[#1f1a16] transition placeholder:text-[#9a8b7a] focus:border-[#a64c4c] focus:outline-none focus:ring-2 focus:ring-[#a64c4c]/30"
                />
              </div>

              {/* Gift message — conditional */}
              <AnimatePresence>
                {form.occasion && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                  >
                    <label className="block text-sm font-semibold text-[#1f1a16] mb-1.5">
                      Gift message{" "}
                      <span className="text-[#8a7b6a] font-normal">
                        (printed on the dedication page)
                      </span>
                    </label>
                    <textarea
                      value={form.giftMessage}
                      onChange={(e) => set("giftMessage", e.target.value)}
                      placeholder={`e.g. "To Emma — may every day be a new adventure. Love, Grandma"`}
                      rows={2}
                      maxLength={200}
                      className="w-full px-4 py-3 border-2 border-[#dfd2b8] rounded-2xl focus:outline-none focus:border-[#a64c4c] focus:ring-2 focus:ring-[#a64c4c]/30 transition text-[#1f1a16] bg-[#fffaf1] resize-none text-sm"
                    />
                    <p className="text-xs text-[#8a7b6a] text-right mt-0.5">
                      {form.giftMessage.length}/200
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </section>


            {/* ── 2.5 Character details ── */}
            <section className="rounded-[1.75rem] border border-[#d8c6a2] bg-[#fff8ec] p-6 shadow-[0_18px_50px_-44px_rgba(31,26,22,0.5)] space-y-4">
              <div>
                <h2 className="font-serif text-2xl text-[#1f1a16] mb-1">
                  Character details
                </h2>
                <p className="text-sm text-[#695f54]">
                  Tell us a few visible details so the art feels more like your
                  child.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-[#1f1a16] mb-1.5">
                    Skin tone <span className="text-[#a64c4c]">(required)</span>
                  </label>
                  <select
                    value={form.skinTone}
                    onChange={(e) => set("skinTone", e.target.value)}
                    className="w-full px-4 py-3 border-2 border-[#dfd2b8] rounded-2xl focus:outline-none focus:border-[#a64c4c] focus:ring-2 focus:ring-[#a64c4c]/30 transition text-[#1f1a16] bg-[#fffaf1]"
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
                  <label className="block text-sm font-semibold text-[#1f1a16] mb-1.5">
                    Hair <span className="text-[#a64c4c]">(required)</span>
                  </label>
                  <select
                    value={form.hairStyle}
                    onChange={(e) => set("hairStyle", e.target.value)}
                    className="w-full px-4 py-3 border-2 border-[#dfd2b8] rounded-2xl focus:outline-none focus:border-[#a64c4c] focus:ring-2 focus:ring-[#a64c4c]/30 transition text-[#1f1a16] bg-[#fffaf1]"
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
                  <label className="block text-sm font-semibold text-[#1f1a16] mb-1.5">
                    Glasses or aids
                  </label>
                  <select
                    value={form.eyewear}
                    onChange={(e) => set("eyewear", e.target.value)}
                    className="w-full px-4 py-3 border-2 border-[#dfd2b8] rounded-2xl focus:outline-none focus:border-[#a64c4c] focus:ring-2 focus:ring-[#a64c4c]/30 transition text-[#1f1a16] bg-[#fffaf1]"
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
                <label className="block text-sm font-semibold text-[#1f1a16] mb-1.5">
                  Anything else we should capture?{" "}
                  <span className="text-[#8a7b6a] font-normal">(optional)</span>
                </label>
                <textarea
                  value={form.characterNotes}
                  onChange={(e) => set("characterNotes", e.target.value)}
                  placeholder="Examples: freckles, favorite hoodie color, wheelchair, curly bangs, hijab, braces..."
                  rows={3}
                  maxLength={240}
                  className="w-full px-4 py-3 border-2 border-[#dfd2b8] rounded-2xl focus:outline-none focus:border-[#a64c4c] focus:ring-2 focus:ring-[#a64c4c]/30 transition text-[#1f1a16] bg-[#fffaf1] resize-none text-sm"
                />
                <p className="text-xs text-[#8a7b6a] text-right mt-0.5">
                  {form.characterNotes.length}/240
                </p>
              </div>
            </section>

            {/* ── 2.75 Supporting characters ── */}
            <section className="rounded-[1.75rem] border border-[#d8c6a2] bg-[#fff8ec] p-6 shadow-[0_18px_50px_-44px_rgba(31,26,22,0.5)] space-y-4">
              <div>
                <h2 className="font-serif text-2xl text-[#1f1a16] mb-1">
                  Who else should appear?
                </h2>
                <p className="text-sm text-[#695f54]">
                  Add family members or pets for the story text and scene notes.
                  Each person can include one optional still reference photo.
                  The child remains the main hero reference.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                {SUPPORTING_CHARACTER_PRESETS.map((preset) => (
                  <button
                    key={preset.role}
                    type="button"
                    onClick={() => addSupportingCharacter(preset)}
                    disabled={form.familyCharacters.length >= SUPPORTING_CHARACTER_LIMIT}
                    className="rounded-full border-2 border-[#dfd2b8] px-3 py-2 text-sm font-semibold text-[#695f54] transition hover:border-[#a64c4c]/60 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    + {preset.label}
                  </button>
                ))}
              </div>

              {form.familyCharacters.length > 0 && (
                <div className="space-y-3">
                  {form.familyCharacters.map((character, index) => (
                    <div
                      key={character.id}
                      className="rounded-2xl border border-[#dfd2b8] bg-[#fffaf1] p-4"
                    >
                      <div className="mb-3 flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-bold text-[#1f1a16]">
                            Supporting character {index + 1}
                            {character.name || character.relationshipLabel
                              ? `: ${character.name || character.relationshipLabel}`
                              : ""}
                          </p>
                          <p className="text-xs leading-5 text-[#8a7b6a]">
                            Use notes for pets: breed, color, markings, size,
                            personality, or how the child talks about them.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeSupportingCharacter(character.id)}
                          className="rounded-full border border-[#dfd2b8] px-3 py-1 text-xs font-semibold text-[#695f54] transition hover:border-[#a64c4c]/60 hover:text-[#a64c4c]"
                        >
                          Remove
                        </button>
                      </div>

                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div>
                          <label className="mb-1.5 block text-sm font-semibold text-[#1f1a16]">
                            Name
                          </label>
                          <input
                            type="text"
                            value={character.name}
                            onChange={(e) =>
                              updateSupportingCharacter(character.id, {
                                name: e.target.value,
                              })
                            }
                            placeholder={character.role === "pet" ? "e.g., Brody" : "e.g., Alexy"}
                            maxLength={80}
                            className="w-full rounded-2xl border-2 border-[#dfd2b8] bg-[#fffaf1] px-4 py-3 text-[#1f1a16] transition focus:border-[#a64c4c] focus:outline-none focus:ring-2 focus:ring-[#a64c4c]/30"
                          />
                        </div>
                        <div>
                          <label className="mb-1.5 block text-sm font-semibold text-[#1f1a16]">
                            Relationship / role
                          </label>
                          <input
                            type="text"
                            value={character.relationshipLabel}
                            onChange={(e) =>
                              updateSupportingCharacter(character.id, {
                                relationshipLabel: e.target.value,
                              })
                            }
                            placeholder="Dad, Grandma, big sister, family dog..."
                            maxLength={80}
                            className="w-full rounded-2xl border-2 border-[#dfd2b8] bg-[#fffaf1] px-4 py-3 text-[#1f1a16] transition focus:border-[#a64c4c] focus:outline-none focus:ring-2 focus:ring-[#a64c4c]/30"
                          />
                        </div>
                        <div>
                          <label className="mb-1.5 block text-sm font-semibold text-[#1f1a16]">
                            Story wording
                          </label>
                          <input
                            type="text"
                            value={character.pronouns}
                            onChange={(e) =>
                              updateSupportingCharacter(character.id, {
                                pronouns: e.target.value,
                              })
                            }
                            placeholder="Dad, Mom, big brother, Grandma, family dog"
                            maxLength={32}
                            className="w-full rounded-2xl border-2 border-[#dfd2b8] bg-[#fffaf1] px-4 py-3 text-[#1f1a16] transition focus:border-[#a64c4c] focus:outline-none focus:ring-2 focus:ring-[#a64c4c]/30"
                          />
                        </div>
                        <label className="flex items-center gap-2 rounded-2xl border border-[#dfd2b8] bg-[#f8f0dd] px-4 py-3 text-sm font-semibold text-[#1f1a16]">
                          <input
                            type="checkbox"
                            checked={character.isGiftRecipient}
                            onChange={(e) =>
                              updateSupportingCharacter(character.id, {
                                isGiftRecipient: e.target.checked,
                              })
                            }
                          />
                          Gift recipient
                        </label>
                      </div>

                      <label className="mt-3 block text-sm font-semibold text-[#1f1a16]">
                        Details to capture
                      </label>
                      <textarea
                        value={character.notes}
                        onChange={(e) =>
                          updateSupportingCharacter(character.id, {
                            notes: e.target.value,
                          })
                        }
                        placeholder={
                          character.role === "pet"
                            ? PET_NOTES_PLACEHOLDER
                            : "Personality, favorite activity, nickname, inside joke, or how this character should show up in the story..."
                        }
                        rows={2}
                        maxLength={180}
                        className="mt-1.5 w-full resize-none rounded-2xl border-2 border-[#dfd2b8] bg-[#fffaf1] px-4 py-3 text-sm text-[#1f1a16] transition focus:border-[#a64c4c] focus:outline-none focus:ring-2 focus:ring-[#a64c4c]/30"
                      />
                      <p className="mt-0.5 text-right text-xs text-[#8a7b6a]">
                        {character.notes.length}/180
                      </p>

                      <div className="mt-3 rounded-2xl border border-[#dfd2b8] bg-[#f8f0dd] p-3">
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-[#1f1a16]">
                              Supporting character reference photo
                              {character.name || character.relationshipLabel
                                ? ` — ${character.name || character.relationshipLabel}`
                                : ""}
                            </p>
                            <p className="text-xs leading-5 text-[#8a7b6a]">
                              Want this character to look more like themselves?
                              One optional still photo helps guide the illustration.
                              The child remains the main hero reference.
                            </p>
                          </div>
                          {character.photoFile && (
                            <button
                              type="button"
                              onClick={() =>
                                updateSupportingCharacter(character.id, {
                                  photoFile: null,
                                  photoDataUrl: null,
                                })
                              }
                              className="rounded-full border border-[#dfd2b8] bg-[#fffaf1] px-3 py-1 text-xs font-semibold text-[#695f54] transition hover:border-[#a64c4c]/60 hover:text-[#a64c4c]"
                            >
                              Remove photo
                            </button>
                          )}
                        </div>

                        {character.photoDataUrl ? (
                          <div className="grid gap-3 sm:grid-cols-[96px_1fr] sm:items-center">
                            <div className="overflow-hidden rounded-xl border border-[#d8c6a2] bg-[#fffaf1]">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={character.photoDataUrl}
                                alt={`${character.relationshipLabel || "Supporting character"} reference`}
                                className="h-24 w-full object-cover"
                              />
                            </div>
                            <div className="min-w-0 text-sm text-[#35564d]">
                              <p className="truncate font-semibold">
                                {character.photoFile?.name}
                              </p>
                              <p className="text-xs text-[#5f766f]">
                                Saved with this character for operator review.
                              </p>
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {/* Both ways to add a photo for this character:
                                camera (capture attr opens the camera on mobile)
                                or an upload from the library. Both reuse the same
                                per-character handler — no submission change. */}
                            <div className="flex flex-wrap gap-2">
                              <label className="flex cursor-pointer items-center gap-1.5 rounded-full bg-[#1f1a16] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#3b3029]">
                                Use camera
                                <input
                                  type="file"
                                  accept={CHECKOUT_PHOTO_ACCEPT_ATTR}
                                  capture="user"
                                  className="hidden"
                                  onChange={(e) => {
                                    const f = e.target.files?.[0];
                                    if (f) processSupportingCharacterPhoto(character.id, f);
                                    e.currentTarget.value = "";
                                  }}
                                />
                              </label>
                              <label className="flex cursor-pointer items-center gap-1.5 rounded-full border-2 border-[#dfd2b8] px-4 py-2 text-sm font-semibold text-[#695f54] transition hover:border-[#a64c4c]/60 hover:bg-[#f5ead2]">
                                Upload photo
                                <input
                                  type="file"
                                  accept={CHECKOUT_PHOTO_ACCEPT_ATTR}
                                  className="hidden"
                                  onChange={(e) => {
                                    const f = e.target.files?.[0];
                                    if (f) processSupportingCharacterPhoto(character.id, f);
                                    e.currentTarget.value = "";
                                  }}
                                />
                              </label>
                            </div>
                            <p className="text-xs text-[#8a7b6a]">
                              JPG/PNG/WebP/HEIC ·{" "}
                              {character.role === "pet"
                                ? "Photo optional for pets"
                                : "Optional"}
                            </p>
                          </div>
                        )}
                        {supportingPhotoErrors[character.id] && (
                          <p role="alert" className="mt-2 text-xs font-medium text-[#8a2f2f]">
                            {supportingPhotoErrors[character.id]}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* ── 3. Format + Delivery ── */}
            <section className="rounded-[1.75rem] border border-[#d8c6a2] bg-[#fff8ec] p-6 shadow-[0_18px_50px_-44px_rgba(31,26,22,0.5)] space-y-4">
              <h2 className="font-serif text-2xl text-[#1f1a16]">
                Choose your format
              </h2>
              {showFathersDayReminder && (
                <div className="rounded-2xl border border-[#a64c4c]/25 bg-[#a64c4c]/10 px-4 py-3 text-sm leading-6 text-[#1f1a16] space-y-3">
                  <div>
                    <strong>Father&apos;s Day timing — by format:</strong>
                  </div>
                  {/* Per-format split. Pulled from FATHERS_DAY_OFFER so
                      the same wording renders on /, /pricing, and
                      /fathers-day. Rules: no guaranteed FD delivery;
                      digital safe cutoff Jun 18; softcover Jun 5 best
                      chance only; hardcover post-holiday keepsake. */}
                  <ul className="space-y-2">
                    <li>
                      <span className="font-semibold text-[#705d87]">Digital PDF:</span>{" "}
                      {FATHERS_DAY_OFFER.digitalTiming}
                    </li>
                    <li>
                      <span className="font-semibold text-[#b96b5f]">Classic softcover:</span>{" "}
                      {FATHERS_DAY_OFFER.softcoverTiming}
                    </li>
                    <li>
                      <span className="font-semibold text-[#5b6047]">Premium hardcover:</span>{" "}
                      {FATHERS_DAY_OFFER.hardcoverTiming}
                    </li>
                  </ul>
                  <p className="text-xs leading-5 text-[#695f54]">
                    <strong className="text-[#1f1a16]">{FATHERS_DAY_OFFER.shippingDisclaimer}</strong>
                    {" "}
                    {FATHERS_DAY_OFFER.proofBeforePrint}
                  </p>
                </div>
              )}
              <div className="space-y-3">
                {FORMATS.map((fmt) => (
                  <button
                    key={fmt.id}
                    type="button"
                    onClick={() => {
                      set("bookFormat", fmt.id);
                      track("format_selected", { format: fmt.id });
                    }}
                    className={`
                    w-full rounded-2xl border-2 p-4 text-left transition-all cursor-pointer
                    ${
                      form.bookFormat === fmt.id
                        ? "border-deep-gold bg-deep-gold/15 ring-2 ring-deep-gold/30 shadow-sm"
                        : "border-[#dfd2b8] hover:border-[#d8c6a2]"
                    }
                  `}
                  >
                    <div className="flex items-start gap-3 sm:gap-4">
                      <span className="min-w-[4.5rem] flex-shrink-0 rounded-full border border-[#dfd2b8] bg-[#fffaf1] px-2 py-1 text-center text-[10px] font-bold uppercase tracking-[0.12em] text-[#695f54] sm:min-w-[5.5rem] sm:text-xs">
                        {fmt.icon}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          <p className="font-bold leading-5 text-[#1f1a16]">
                            {fmt.label}
                          </p>
                          {fmt.badge && (
                            <span className="rounded-full bg-[#a64c4c] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-white sm:text-xs">
                              {fmt.badge}
                            </span>
                          )}
                        </div>
                        <p className="text-sm leading-5 text-[#695f54]">
                          ⚡ {fmt.delivery}
                        </p>
                        <p className="mt-1 text-xs leading-5 text-[#8a7b6a]">
                          {fmt.deliveryDetail}
                        </p>
                      </div>
                      <span className="hidden flex-shrink-0 font-bold text-xl text-[#1f1a16] sm:block">
                        {fmt.price}
                      </span>
                    </div>
                    <div className="mt-3 flex items-center justify-between border-t border-[#dfd2b8] pt-3 sm:hidden">
                      <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[#695f54]">
                        Total
                      </span>
                      <span className="font-bold text-xl text-[#1f1a16]">
                        {fmt.price}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </section>

            {/* ── 4. Email + Preview Promise ── */}
            <section className="rounded-[1.75rem] border border-[#d8c6a2] bg-[#fff8ec] p-6 shadow-[0_18px_50px_-44px_rgba(31,26,22,0.5)] space-y-4">
              <div>
                <h2 className="font-serif text-2xl text-[#1f1a16] mb-1">
                  Where should we send everything?
                </h2>
                <p className="text-sm text-[#695f54]">
                  We&apos;ll send your confirmation, delivery updates, and any
                  preview approval steps here.
                </p>
              </div>
              <input
                id="email"
                type="email"
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
                placeholder="your@email.com"
                required
                aria-invalid={form.email.length > 0 && !emailLooksValid}
                aria-describedby={
                  form.email.length > 0 && !emailLooksValid ? "email-error" : undefined
                }
                className={`w-full px-4 py-3 border-2 rounded-2xl focus:outline-none focus:ring-2 transition text-[#1f1a16] bg-[#fffaf1] ${
                  form.email.length > 0 && !emailLooksValid
                    ? "border-[#a64c4c] focus:border-[#a64c4c] focus:ring-[#a64c4c]/30"
                    : "border-[#dfd2b8] focus:border-[#a64c4c] focus:ring-[#a64c4c]/30"
                }`}
              />
              {form.email.length > 0 && !emailLooksValid && (
                <p
                  id="email-error"
                  role="alert"
                  className="text-sm font-medium text-[#8a2f2f]"
                >
                  Enter a valid email address (like name@example.com) so we can
                  send your proof and book.
                </p>
              )}
              <div className="rounded-2xl border border-[#cfe0d8] bg-[#eef4f1] px-4 py-3 text-sm text-[#35564d]">
                ✨ {PRINT_PREVIEW_PROMISE}
              </div>
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
                    theme: file && !prev.theme ? "custom-voice-story" : prev.theme,
                    voiceFile: file,
                    voicePreviewUrl: previewUrl,
                    voiceSource: source,
                    voiceConsent: file ? prev.voiceConsent : false,
                  }))
                }
                onConsentChange={(consent) =>
                  setForm((prev) => ({ ...prev, voiceConsent: consent }))
                }
              />
            )}
          </div>

          <aside className="space-y-5 lg:sticky lg:top-6">
            <section className="rounded-[1.5rem] border border-[#d8c6a2] bg-[#fbf6e9] p-5 shadow-[0_24px_70px_-58px_rgba(36,25,20,0.65)]">
              <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8a7663]">
                Your book
              </p>
              <h1 className="font-serif text-2xl font-semibold italic leading-tight text-[#a64c4c]">
                {coverTitle}
              </h1>

              <div className="mt-5 grid grid-cols-[84px,1fr] gap-4">
                <div className="relative aspect-[3/4] overflow-hidden rounded-lg border border-[#d8c6a2] bg-[#d8b98f] shadow-lg">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={selectedSampleImage}
                    alt="Book preview"
                    className="h-full w-full object-cover opacity-80"
                  />
                  <div className="absolute inset-0 bg-[#a66c43]/35" />
                  <div className="absolute inset-x-2 top-4 text-center font-serif text-[11px] italic leading-4 text-[#fff8ec]">
                    {coverTitle}
                  </div>
                  <div className="absolute inset-x-2 bottom-4 text-center text-[8px] uppercase tracking-[0.18em] text-[#fff8ec]/80">
                    starring {heroName}
                  </div>
                </div>

                <dl className="grid grid-cols-2 gap-x-5 gap-y-3 text-sm">
                  <div>
                    <dt className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#8a7663]">
                      Occasion
                    </dt>
                    <dd className="mt-1 font-semibold text-[#241914]">
                      {selectedOccasion?.label ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#8a7663]">
                      Format
                    </dt>
                    <dd className="mt-1 font-semibold text-[#241914]">
                      {printFormat}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#8a7663]">
                      Starring
                    </dt>
                    <dd className="mt-1 font-semibold text-[#241914]">
                      {heroName}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#8a7663]">
                      Book pages
                    </dt>
                    <dd className="mt-1 font-semibold text-[#241914]">
                      {bookPageCount} total · {illustratedStoryPageCount} illustrated
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#8a7663]">
                      Photos
                    </dt>
                    <dd className="mt-1 font-semibold text-[#241914]">
                      {form.photoFile ? "1 photo" : "Add later"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#8a7663]">
                      Family
                    </dt>
                    <dd className="mt-1 font-semibold text-[#241914]">
                      {form.familyCharacters.length
                        ? `${form.familyCharacters.length} added`
                        : "Optional"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#8a7663]">
                      Shipping
                    </dt>
                    <dd className="mt-1 font-semibold text-[#a64c4c]">
                      {form.bookFormat === "digital" ? "None" : "US, included"}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="mt-5 rounded-2xl border border-[#dfd2b8] bg-[#f8f0dd] p-4">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <h2 className="font-serif text-xl font-semibold text-[#241914]">
                      Order summary
                    </h2>
                    <p className="mt-1 text-sm text-[#6e6154]">
                      {lessonSummary
                        ? `${lessonSummary} story`
                        : "Personalized story"}
                      {occasionSummary ? ` · ${occasionSummary}` : ""}
                    </p>
                  </div>
                  <span className="font-bold text-[#241914]">
                    {selectedFormat?.price ?? "—"}
                  </span>
                </div>
                <div className="space-y-2 border-t border-[#d8c6a2] pt-3 text-sm text-[#6e6154]">
                  <div className="flex justify-between gap-3">
                    <span>{printFormat}</span>
                    <span className="font-semibold text-[#241914]">
                      {selectedFormat?.price ?? "—"}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                      <span>Book pages</span>
                    <span className="font-semibold text-[#241914]">
                      {bookPageCount} total
                      <span className="ml-1 font-normal text-[#6e6154]">
                        ({illustratedStoryPageCount} illustrated story pages)
                      </span>
                    </span>
                  </div>
                  {form.familyCharacters.length > 0 && (
                    <div className="flex justify-between gap-3">
                      <span>Supporting characters</span>
                      <span className="font-semibold text-[#241914]">
                        {form.familyCharacters.length}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between gap-3">
                    <span>
                      Shipping {form.bookFormat === "digital" ? "" : "(US)"}
                    </span>
                    <span className="font-semibold text-[#a64c4c]">
                      {form.bookFormat === "digital" ? "—" : "Included"}
                    </span>
                  </div>
                  <div className="flex justify-between border-t border-[#d8c6a2] pt-3 text-lg text-[#241914]">
                    <span className="font-serif font-semibold">Total</span>
                    <span className="font-bold">{totalPrice}</span>
                  </div>
                </div>
              </div>
            </section>

            <section className="rounded-[1.5rem] border border-[#d8c6a2] bg-[#ead8b8] p-5 text-[#241914]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#a64c4c]">
                What happens next
              </p>
              <h2 className="mt-2 font-serif text-2xl font-semibold leading-tight">
                Nothing prints until <em className="text-[#a64c4c]">you</em> say
                so.
              </h2>
              <ol className="mt-5 space-y-4 text-sm leading-6 text-[#4f4035]">
                <li className="flex gap-3">
                  <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-[#a64c4c] bg-[#f8f0dd] font-serif text-[#a64c4c]">
                    1
                  </span>
                  <span>
                    <strong className="block text-[#241914]">
                      We send a digital proof
                    </strong>
                    Within 2 business days, you get a private link to review
                    every page.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-[#a64c4c] bg-[#f8f0dd] font-serif text-[#a64c4c]">
                    2
                  </span>
                  <span>
                    <strong className="block text-[#241914]">
                      You review and reply
                    </strong>
                    Approve it as-is or ask us to revise wording, photo
                    placement, or art.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-[#a64c4c] bg-[#f8f0dd] font-serif text-[#a64c4c]">
                    3
                  </span>
                  <span>
                    <strong className="block text-[#241914]">
                      Then we print or deliver
                    </strong>
                    Nothing prints until you approve your proof. After you
                    approve, digital books are delivered and print books ship.
                  </span>
                </li>
              </ol>
            </section>

            {/* Pre-purchase story-confidence preview — deterministic + local,
                rendered before the payment boundary. No-op until child name +
                story are chosen. */}
            <StoryPreviewCard
              childName={form.childName}
              theme={form.theme}
              lesson={form.lesson}
              giftMessage={form.giftMessage}
              characterNotes={form.characterNotes}
              voiceAttached={VOICE_BETA_ENABLED && Boolean(form.voiceFile)}
              voiceTranscribed={false}
              guidedPhotoCount={guidedCaptureEnabled ? guidedFrames.length : 0}
              bookFormat={form.bookFormat}
            />

            <div className="space-y-3 pb-10">
              {/* Disabled-CTA reason. Listed before the button so a screen
                  reader / sighted reviewer immediately knows WHY the button
                  is greyed instead of guessing. Computed from the same
                  inputs that gate isReadyToPay. */}
              {!isReadyToPay && !isSubmitting && (() => {
                const missing: string[] = [];
                if (!form.theme) missing.push('story');
                if (!form.childName) missing.push("child's name");
                if (!form.bookFormat) missing.push('format');
                if (!form.email) missing.push('email');
                else if (!emailLooksValid) missing.push('a valid email address');
                if (!form.skinTone) missing.push('skin tone');
                if (!form.hairStyle) missing.push('hair');
                if (VOICE_BETA_ENABLED && form.voiceFile != null && !form.voiceConsent) {
                  missing.push('story inspiration consent');
                }
                return (
                  <p
                    id="cta-reason"
                    role="status"
                    className="rounded-xl border border-deep-gold/50 bg-deep-gold/15 px-3 py-2 text-center text-xs font-semibold text-[#3a2c10]"
                  >
                    Finish these before continuing: {missing.join(' · ')}
                  </p>
                );
              })()}
              {/* Inline submit error. Shows the SPECIFIC server reason and
                  reassures the customer nothing was saved or charged — so a
                  failed submission (e.g. a voice-save abort) never looks like
                  it went through. */}
              {/* Per-file pre-upload status (split-asset intake). Shows a
                  spinner while each photo/voice file uploads to secure storage,
                  a check when saved, and an error marker on the file that
                  failed — with a clear "not charged yet" reassurance. The retry
                  is the Place-Order button itself: already-uploaded files are
                  skipped (idempotent), so only the failed file re-sends. */}
              {assetUploadStatuses.length > 0 && (
                <div
                  data-testid="asset-upload-status"
                  role="status"
                  aria-live="polite"
                  className="rounded-xl border border-[#dfd2b8] bg-[#fffaf1] px-4 py-3 text-sm"
                >
                  <p className="font-semibold text-[#1f1a16]">
                    Saving your files securely — you have not been charged yet.
                  </p>
                  <ul className="mt-2 space-y-1">
                    {assetUploadStatuses.map((s) => (
                      <li key={s.key} className="flex items-center gap-2 text-[#5f5346]">
                        <span aria-hidden="true">
                          {s.status === "uploading" && (
                            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#a64c4c]/30 border-t-[#a64c4c]" />
                          )}
                          {s.status === "uploaded" && <span className="text-[#2f7a4d]">✓</span>}
                          {s.status === "error" && <span className="text-[#a64c4c]">✗</span>}
                        </span>
                        <span className="capitalize">{s.label}</span>
                        {/* Status word: never color-only — icon + word (CD spec §02
                            verbatim: Sending… / Saved / Didn't send). No bytes,
                            HTTP codes, or provider/bucket strings. */}
                        <span className="ml-auto text-xs text-[#8a7b6a]">
                          {s.status === "uploading"
                            ? "Sending…"
                            : s.status === "uploaded"
                              ? "Saved"
                              : "Didn't send — tap Continue to retry just this file"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {submitError && (
                <div
                  role="alert"
                  aria-live="assertive"
                  data-testid="submit-error"
                  className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700"
                >
                  <p className="font-semibold">We couldn&apos;t start your order.</p>
                  <p className="mt-1">{submitError}</p>
                  <p className="mt-1 text-xs text-red-600">
                    You have not been charged. If you recorded a voice note,
                    download it from the section above before retrying so it
                    isn&apos;t lost.
                  </p>
                </div>
              )}
              {/* Disabled state uses a legible muted tan (not opacity-50, which
                  faded the gold to an illegible "broken"-looking button on the
                  cream page) and an explicit reason via aria-describedby. */}
              <button
                type="submit"
                disabled={isSubmitting || !isReadyToPay}
                aria-disabled={isSubmitting || !isReadyToPay}
                aria-describedby={
                  !isReadyToPay && !isSubmitting ? "cta-reason" : undefined
                }
                className="w-full rounded-2xl bg-deep-gold py-4 text-lg font-bold text-navy shadow-md transition-all hover:-translate-y-0.5 hover:bg-deep-gold/90 hover:shadow-lg disabled:translate-y-0 disabled:cursor-not-allowed disabled:bg-[#e3d7bf] disabled:text-[#5c5145] disabled:shadow-none"
              >
                {isSubmitting
                  ? "Processing…"
                  : `Continue to secure payment${selectedFormat ? ` — ${selectedFormat.price}` : ""}`}
              </button>
              <p className="text-center text-xs leading-5 text-[#8a7b6a]">
                Secured by Stripe · Proof approval before printing · Your data
                is never shared
              </p>
            </div>
          </aside>
        </form>
      </div>
    </main>
  );
}
