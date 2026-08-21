"use client";
import React, { useState, useRef, useCallback, useEffect } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { Progress } from "@/components/ui/progress";
import { PRINT_PREVIEW_PROMISE, PROMO_CODE_HELP } from "@/lib/checkout-flow";
import {
  PROOF_REVIEW_ASSURANCE,
  PROOF_TURNAROUND_WINDOW,
  PROOF_VOLUME_NOTE,
} from "@/lib/proof-turnaround";
import { checkoutTrackingFromSearchParams } from "@/lib/checkout-tracking";
import { VoiceRecorderSection } from "@/components/checkout/VoiceRecorderSection";
import { GuidedPhotoCapture } from "@/components/checkout/GuidedPhotoCapture";
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
import { getFathersDayCountdown } from "@/lib/fathers-day";
import { currentGaClientId, track } from "@/lib/analytics";
import { buildAutoShrinkNotice, shrinkPhotoForUpload } from "@/lib/photo-upload";
import {
  createSupportingCharacterDraft,
  canNavigateToCheckoutStep,
  getCheckoutPaymentBlockers,
  getCheckoutProgress,
  supportingCharacterDraftMissingFields,
} from "@/lib/checkout-progressive";

// ── Constants ──────────────────────────────────────────────────────────────

const CHECKOUT_PHOTO_MAX_BYTES = 1.1 * 1024 * 1024;

const CUSTOM_STORY_THEME_ID = "custom-voice-story";

const LAUNCH_THEME_IDS = new Set([
  CUSTOM_STORY_THEME_ID,
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
    label: "Digital proof",
    icon: "Digital",
    price: "$19.00",
    priceNum: 19,
    badge: "Most flexible",
    delivery: `Digital proof usually ready in ${PROOF_TURNAROUND_WINDOW}`,
    deliveryDetail:
      "32-page proof first · Final high-res PDF delivered after approval · No printing or shipping step",
  },
  {
    id: "classic",
    label: "Classic softcover",
    icon: "Softcover",
    price: "$39.00",
    priceNum: 39,
    delivery: "Proof first, then softcover ships after approval",
    deliveryDetail:
      `Proof usually ready in ${PROOF_TURNAROUND_WINDOW} · Softcover ships 5–7 business days after approval · Digital PDF included`,
  },
  {
    id: "premium",
    label: "Premium hardcover",
    icon: "Hardcover",
    price: "$64.00",
    priceNum: 64,
    delivery: "Proof first, then hardcover ships after approval",
    deliveryDetail:
      `Proof usually ready in ${PROOF_TURNAROUND_WINDOW} · Hardcover ships 5–7 business days after approval · Digital PDF included`,
  },
];

const DEFAULT_BOOK_FORMAT = "digital";
const TOTAL_BOOK_PAGE_COUNT = 32;
const ILLUSTRATED_STORY_PAGE_COUNT = 24;

const SUPPORTING_CHARACTER_LIMIT = 4;
const PRIMARY_HERO_BETA_ENABLED = process.env.NEXT_PUBLIC_HSB_PRIMARY_HERO_BETA === "true";
const PRIMARY_HERO_TYPES = [
  { id: "child", label: "Child", helper: "Available now" },
  { id: "parent", label: "Parent", helper: "Available by review only" },
  { id: "grandparent", label: "Grandparent", helper: "Available by review only" },
] as const;
const PET_NOTES_PLACEHOLDER = "Breed, color, size, personality, or markings";
const MUST_INCLUDE_OPTIONS = [
  { id: "glasses", label: "Glasses" },
  { id: "hearing-aid", label: "Hearing aid" },
  { id: "wheelchair", label: "Wheelchair" },
  { id: "head-covering", label: "Head covering" },
  { id: "braces", label: "Braces" },
  { id: "custom-detail", label: "Custom detail" },
] as const;
const SUPPORTING_CHARACTER_PRESETS = [
  { role: "co-hero", label: "Co-hero", relationshipLabel: "co-hero", pronouns: "", isGiftRecipient: false },
  { role: "dad", label: "Dad", relationshipLabel: "Dad", pronouns: "", isGiftRecipient: false },
  { role: "mom", label: "Mom", relationshipLabel: "Mom", pronouns: "", isGiftRecipient: false },
  { role: "sibling", label: "Sibling", relationshipLabel: "sibling", pronouns: "", isGiftRecipient: false },
  { role: "grandparent", label: "Grandparent", relationshipLabel: "grandparent", pronouns: "", isGiftRecipient: false },
  { role: "pet", label: "Dog / pet", relationshipLabel: "family dog", pronouns: "", isGiftRecipient: false },
] as const;

const CHECKOUT_PHOTO_ACCEPT_ATTR = "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp";

function supportingCharacterLabel(character: SupportingCharacter): string {
  return (character.name || character.relationshipLabel || character.role || "family member").trim();
}

function isHumanSupportingCharacter(character: SupportingCharacter): boolean {
  return character.role !== "pet";
}

function missingSupportingCharacterDescriptionLabels(characters: SupportingCharacter[]): string[] {
  return characters
    .filter((character) => character.appearsInStory !== false)
    .filter(isHumanSupportingCharacter)
    .filter((character) => !character.photoFile)
    .filter((character) => !character.notes.trim())
    .map(supportingCharacterLabel);
}

// Phase-A story upload visibility. This is intentionally default-OFF and is
// not tied to NEXT_PUBLIC_HSB_VOICE_BETA. Enable only with
// NEXT_PUBLIC_HSB_STORY_UPLOAD=true after legal/product QA.
const STORY_UPLOAD_ENABLED = process.env.NEXT_PUBLIC_HSB_STORY_UPLOAD === "true";

const STORAGE_KEY = "hsb_order_v1";
const STORAGE_TTL = 7 * 24 * 60 * 60 * 1000;
const RECOVERY_DEBOUNCE_MS = 1500;

function looksLikeEmail(e: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
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
  // `childName` remains the authoritative hero field submitted to the server
  // (legacy compatibility). The fully-custom hero fields below are additive
  // Phase-A groundwork — recipient context + multi-person photo disambiguation.
  childName: string;
  heroType: string;
  childAge: string;
  recipientName: string;
  recipientRelationship: string;
  heroPhotoFocusLabel: string;
  heroPhotoCropHint: string;
  lesson: string;
  occasion: string;
  giftMessage: string;
  characterNotes: string;
  customStoryMemory: string;
  customStorySourceMode: "audio" | "written" | "";
  familyCharacters: SupportingCharacter[];
  mustInclude: string[];
  mustIncludeOther: string;
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
  mustInclude: string[];
  mustIncludeOther: string;
  focusPersonLabel: string;
  cropHint: string;
}

const emptyForm: FormState = {
  photoFile: null,
  photoDataUrl: null,
  theme: "",
  childName: "",
  heroType: "child",
  childAge: "",
  recipientName: "",
  recipientRelationship: "",
  heroPhotoFocusLabel: "",
  heroPhotoCropHint: "",
  lesson: "",
  occasion: "",
  giftMessage: "",
  characterNotes: "",
  customStoryMemory: "",
  customStorySourceMode: "",
  familyCharacters: [],
  mustInclude: [],
  mustIncludeOther: "",
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
        heroType: form.heroType,
        childAge: form.childAge,
        recipientName: form.recipientName,
        recipientRelationship: form.recipientRelationship,
        lesson: form.lesson,
        occasion: form.occasion,
        giftMessage: form.giftMessage,
        characterNotes: form.characterNotes,
        customStoryMemory: form.customStoryMemory,
        customStorySourceMode: form.customStorySourceMode,
        familyCharacters: form.familyCharacters.map((character) => ({
          ...character,
          pronouns: "",
        })),
        mustInclude: form.mustInclude,
        mustIncludeOther: form.mustIncludeOther,
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
    pronouns: "",
    notes: character.notes === PET_NOTES_PLACEHOLDER ? "" : character.notes,
    mustInclude: Array.isArray(character.mustInclude) ? character.mustInclude : [],
    mustIncludeOther: character.mustIncludeOther ?? "",
    // Backfill Phase-A photo-assignment fields for progress saved by older
    // builds so controlled inputs never receive undefined.
    focusPersonLabel: character.focusPersonLabel ?? "",
    cropHint: character.cropHint ?? "",
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
  const [currentStepId, setCurrentStepId] = useState<"hero-details" | "hero-appearance" | "story" | "people" | "review">("hero-details");
  const [supportingCharacterDraft, setSupportingCharacterDraft] = useState<SupportingCharacter | null>(null);
  const [editingSupportingCharacterId, setEditingSupportingCharacterId] = useState<string | null>(null);
  const [supportingPhotoPendingId, setSupportingPhotoPendingId] = useState<string | null>(null);
  const heroPhotoOperationRef = useRef(0);
  const supportingPhotoOperationRef = useRef(0);
  const [stepError, setStepError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, boolean>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  // Specific, inline submit error. We use an in-page banner rather than
  // window.alert so the exact server reason is visible/scrollable (alerts get
  // dismissed instantly on mobile) and so we can reassure the customer that no
  // charge was made and nothing was saved when submission fails before Stripe.
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [photoNotice, setPhotoNotice] = useState<string | null>(null);
  const [showRecovery, setShowRecovery] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const stepRefs = useRef<Record<string, HTMLElement | null>>({});
  const fieldRefs = useRef<Record<string, HTMLElement | null>>({});
  const guidedCaptureEnabled = isGuidedPhotoCaptureEnabled();
  const [guidedFrames, setGuidedFrames] = useState<GuidedPhotoFile[]>([]);
  const [guidedConsent, setGuidedConsent] = useState(false);
  const [showGuidedPhotos, setShowGuidedPhotos] = useState(false);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    const occasionFromUrl = (params.get("occasion") || "").trim().slice(0, 100);
    const themeFromDirection = themeIdFromDirection(directionFromUrl);
    const nextFormat = normalizeBookFormat(formatFromUrl);
    const savedWithDefaults = saved
      ? {
          ...saved,
          bookFormat: normalizeBookFormat(saved.bookFormat) || DEFAULT_BOOK_FORMAT,
          familyCharacters: normalizeSavedFamilyCharacters(saved.familyCharacters),
          mustInclude: Array.isArray(saved.mustInclude) ? saved.mustInclude : [],
          mustIncludeOther: saved.mustIncludeOther ?? "",
        }
      : null;
    // NamePreview URL contract: childNameFromUrl ? { childName: childNameFromUrl }
    const childNamePrefill = childNameFromHandoff || childNameFromUrl;
    const queryPrefill: Partial<FormState> = {
      ...(nextFormat ? { bookFormat: nextFormat } : {}),
      ...(childNamePrefill ? { childName: childNamePrefill } : {}),
      ...(themeFromDirection ? { theme: themeFromDirection } : {}),
      ...(occasionFromUrl ? { occasion: occasionFromUrl } : {}),
    };

    if (savedWithDefaults && (savedWithDefaults.childName || savedWithDefaults.theme)) {
      setShowRecovery(true);
      setForm((prev) => ({ ...prev, ...savedWithDefaults, ...queryPrefill }));
    } else if (nextFormat || childNamePrefill || themeFromDirection || occasionFromUrl) {
      setForm((prev) => ({ ...prev, ...queryPrefill }));
    }

    track("begin_checkout", {
      hadSavedProgress: Boolean(saved && (saved.childName || saved.theme)),
      formatFromUrl: nextFormat || null,
      childNameFromUrl: childNameFromUrl ? "yes" : "no",
      childNameFromNamePreview: childNameFromHandoff ? "yes" : "no",
      directionFromUrl: directionFromUrl ? directionFromUrl.slice(0, 32) : null,
      occasionFromUrl: occasionFromUrl || null,
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
    form.recipientName,
    form.recipientRelationship,
    form.lesson,
    form.occasion,
    form.giftMessage,
    form.characterNotes,
    form.customStoryMemory,
    form.customStorySourceMode,
    form.familyCharacters,
    form.mustInclude,
    form.mustIncludeOther,
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

  const registerStepRef = (stepId: string) => (node: HTMLElement | null) => {
    stepRefs.current[stepId] = node;
  };

  const registerFieldRef = (fieldId: string) => (node: HTMLElement | null) => {
    fieldRefs.current[fieldId] = node;
  };

  const addSupportingCharacter = (
    preset: (typeof SUPPORTING_CHARACTER_PRESETS)[number],
  ) => {
    if (supportingCharacterDraft || form.familyCharacters.length >= SUPPORTING_CHARACTER_LIMIT) {
      return;
    }
    const draft = createSupportingCharacterDraft({
      role: preset.role,
      relationshipLabel: preset.relationshipLabel,
      pronouns: preset.pronouns,
      isGiftRecipient: preset.isGiftRecipient,
    });
    if (!draft) return;
    setSupportingCharacterDraft(draft);
    setEditingSupportingCharacterId(null);
    setCurrentStepId("people");
    setStepError(null);
  };

  const updateSupportingCharacter = (
    id: string,
    patch: Partial<SupportingCharacter>,
  ) => {
    if (supportingCharacterDraft?.id === id) {
      setSupportingCharacterDraft((prev) => (prev ? { ...prev, ...patch } : prev));
      return;
    }
    setForm((prev) => ({
      ...prev,
      familyCharacters: prev.familyCharacters.map((character) =>
        character.id === id ? { ...character, ...patch } : character,
      ),
    }));
  };

  const removeSupportingCharacter = (id: string) => {
    if (editingSupportingCharacterId === id) {
      supportingPhotoOperationRef.current += 1;
      setSupportingPhotoPendingId(null);
    }
    setForm((prev) => ({
      ...prev,
      familyCharacters: prev.familyCharacters.filter((character) => character.id !== id),
    }));
    if (editingSupportingCharacterId === id) {
      setSupportingCharacterDraft(null);
      setEditingSupportingCharacterId(null);
    }
  };

  const editSupportingCharacter = (id: string) => {
    if (supportingCharacterDraft) return;
    const existing = form.familyCharacters.find((character) => character.id === id);
    if (!existing) return;
    supportingPhotoOperationRef.current += 1;
    setSupportingPhotoPendingId(null);
    setSupportingCharacterDraft({ ...existing });
    setEditingSupportingCharacterId(id);
    setCurrentStepId("people");
    setStepError(null);
  };

  const cancelSupportingCharacter = () => {
    supportingPhotoOperationRef.current += 1;
    setSupportingPhotoPendingId(null);
    setSupportingCharacterDraft(null);
    setEditingSupportingCharacterId(null);
    setStepError(null);
    setFieldErrors({});
  };

  const saveSupportingCharacter = () => {
    if (!supportingCharacterDraft || supportingPhotoPendingId === supportingCharacterDraft.id) return;
    const missing = supportingCharacterDraftMissingFields(supportingCharacterDraft);
    if (missing.length > 0) {
      setStepError(`Missing: ${missing.join(", ")}`);
      setFieldErrors({ "supportingCharacter.name": true });
      return;
    }

    setForm((prev) => {
      const existingIndex = prev.familyCharacters.findIndex((character) => character.id === supportingCharacterDraft.id);
      if (existingIndex >= 0) {
        return {
          ...prev,
          familyCharacters: prev.familyCharacters.map((character) =>
            character.id === supportingCharacterDraft.id ? supportingCharacterDraft : character,
          ),
        };
      }
      return {
        ...prev,
        familyCharacters: [...prev.familyCharacters, supportingCharacterDraft],
      };
    });
    supportingPhotoOperationRef.current += 1;
    setSupportingPhotoPendingId(null);
    setSupportingCharacterDraft(null);
    setEditingSupportingCharacterId(null);
    setStepError(null);
    setFieldErrors({});
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
  const missingSupportingDescriptionLabels = missingSupportingCharacterDescriptionLabels(form.familyCharacters);
  const isCustomStorySelected = form.theme === CUSTOM_STORY_THEME_ID;
  const customStoryTheme = THEMES.find((theme) => theme.id === CUSTOM_STORY_THEME_ID) ?? null;
  const templateThemes = THEMES.filter((theme) => theme.id !== CUSTOM_STORY_THEME_ID);
  const hasCustomStoryInput = Boolean(form.voiceFile || form.customStoryMemory.trim());
  const customStorySourceMode = form.customStorySourceMode || (form.voiceFile ? "audio" : form.customStoryMemory.trim() ? "written" : "");
  const guidedPhotoSummary = guidedFrames.length > 0
    ? `${guidedFrames.length} guided photo${guidedFrames.length === 1 ? "" : "s"} added`
    : "5 quick angles, about a minute (optional).";
  const checkoutProgress = getCheckoutProgress({
    theme: form.theme,
    childName: form.childName,
    characterNotes: form.characterNotes,
    photoFile: form.photoFile,
    familyCharacters: form.familyCharacters,
    bookFormat: form.bookFormat,
    email: form.email,
    voiceFile: form.voiceFile,
    voiceConsent: form.voiceConsent,
    activeSupportingCharacterDraft: supportingCharacterDraft,
  });
  const checkoutSteps = checkoutProgress.steps;
  const currentStep = checkoutSteps.find((step) => step.id === currentStepId) ?? checkoutSteps[0];
  const currentStepIndex = checkoutSteps.findIndex((step) => step.id === currentStep.id);
  const paymentBlockers = getCheckoutPaymentBlockers({
    theme: form.theme,
    childName: form.childName,
    characterNotes: form.characterNotes,
    photoFile: form.photoFile,
    familyCharacters: form.familyCharacters,
    bookFormat: form.bookFormat,
    email: form.email,
    voiceFile: form.voiceFile,
    voiceConsent: form.voiceConsent,
    activeSupportingCharacterDraft: supportingCharacterDraft,
  });
  const missingVoiceConsent =
    STORY_UPLOAD_ENABLED && form.voiceFile != null && !form.voiceConsent;
  const isReadyToPay =
    Boolean(form.theme) &&
    Boolean(form.childName) &&
    Boolean(form.bookFormat) &&
    Boolean(form.email) &&
    Boolean(form.photoFile || form.characterNotes.trim()) &&
    missingSupportingDescriptionLabels.length === 0 &&
    !supportingCharacterDraft &&
    !missingVoiceConsent;
  const completedStepCount = [
    Boolean(form.theme),
    Boolean(form.childName),
    Boolean(form.bookFormat),
    looksLikeEmail(form.email),
    Boolean(form.photoFile || form.characterNotes.trim()),
  ].filter(Boolean).length;
  const progressValue = (completedStepCount / CHECKOUT_STEPS.length) * 100;

  useEffect(() => {
    const firstBlockingStep = checkoutProgress.currentStep.id;
    const currentIndex = checkoutSteps.findIndex((step) => step.id === currentStepId);
    const blockingIndex = checkoutSteps.findIndex((step) => step.id === firstBlockingStep);
    if (blockingIndex >= 0 && currentIndex >= 0 && blockingIndex < currentIndex) {
      setCurrentStepId(firstBlockingStep);
    }
  }, [checkoutProgress.currentStep.id, checkoutSteps, currentStepId]);

  const scrollToField = useCallback((fieldName: string | null, stepId?: string) => {
    if (stepId) {
      setCurrentStepId(stepId as typeof currentStepId);
    }
    requestAnimationFrame(() => {
      const target = (fieldName ? fieldRefs.current[fieldName] : null) ?? (stepId ? stepRefs.current[stepId] : null);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        if ("focus" in target) {
          (target as HTMLElement).focus();
        }
      }
    });
  }, [currentStepId]);

  const continueCurrentStep = useCallback(() => {
    if (currentStep.missingFields.length > 0 || currentStep.status === "needs_attention") {
      setStepError(`Missing: ${currentStep.missingFields.join(", ")}`);
      if (currentStep.firstInvalidField) {
        setFieldErrors({ [currentStep.firstInvalidField]: true });
      }
      scrollToField(currentStep.firstInvalidField, currentStep.id);
      return;
    }

    setStepError(null);
    setFieldErrors({});
    const nextStep = checkoutSteps[currentStepIndex + 1];
    if (nextStep) {
      setCurrentStepId(nextStep.id);
      scrollToField(null, nextStep.id);
    }
  }, [checkoutSteps, currentStep, currentStepIndex, scrollToField]);

  const processPhoto = useCallback(async (file: File) => {
    const operation = ++heroPhotoOperationRef.current;
    try {
      const uploadFile = await shrinkPhotoForUpload(file, CHECKOUT_PHOTO_MAX_BYTES);
      if (operation !== heroPhotoOperationRef.current) return;
      if (uploadFile.size < file.size) {
        setPhotoNotice(buildAutoShrinkNotice(file.size, uploadFile.size));
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        if (operation !== heroPhotoOperationRef.current) return;
        setForm((prev) => ({
          ...prev,
          photoFile: uploadFile,
          photoDataUrl: e.target?.result as string,
        }));
      };
      reader.readAsDataURL(uploadFile);
    } catch {
      if (operation !== heroPhotoOperationRef.current) return;
      setSubmitError(
        "That photo is too large for checkout on this device. Please choose a smaller JPG/PNG, screenshot/crop it, or continue without the child photo and add it later.",
      );
    }
  }, []);

  const processSupportingCharacterPhoto = useCallback(async (id: string, file: File) => {
    const operation = ++supportingPhotoOperationRef.current;
    setSupportingPhotoPendingId(id);
    try {
      const uploadFile = await shrinkPhotoForUpload(file, CHECKOUT_PHOTO_MAX_BYTES);
      if (operation !== supportingPhotoOperationRef.current) return;
      if (uploadFile.size < file.size) {
        setPhotoNotice(buildAutoShrinkNotice(file.size, uploadFile.size));
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        if (operation !== supportingPhotoOperationRef.current) return;
        const photoDataUrl = e.target?.result as string;
        setSupportingCharacterDraft((prev) =>
          prev && prev.id === id ? { ...prev, photoFile: uploadFile, photoDataUrl } : prev,
        );
        // The saved character is intentionally untouched until Save person.
        // This preserves cancel semantics even when FileReader completes late.
        setSupportingPhotoPendingId(null);
      };
      reader.onerror = () => {
        if (operation !== supportingPhotoOperationRef.current) return;
        setSupportingPhotoPendingId(null);
        setSubmitError("We couldn't read that family/pet photo. Please choose it again.");
      };
      reader.readAsDataURL(uploadFile);
    } catch {
      if (operation !== supportingPhotoOperationRef.current) return;
      setSupportingPhotoPendingId(null);
      setSubmitError(
        "That family/pet photo is too large for checkout on this device. Please choose a smaller JPG/PNG or crop/screenshot it before retrying.",
      );
    }
  }, []);

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
    if (currentStepId !== "review" || !isReadyToPay) {
      setStepError("Finish the checkout steps before continuing to payment.");
      return;
    }
    setIsSubmitting(true);
    setSubmitError(null);
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
      const attemptStorageKey = "hsb-checkout-attempt-id";
      let checkoutAttemptId = sessionStorage.getItem(attemptStorageKey);
      if (!checkoutAttemptId) {
        checkoutAttemptId = crypto.randomUUID().replace(/-/g, "");
        sessionStorage.setItem(attemptStorageKey, checkoutAttemptId);
      }
      payload.set("checkoutAttemptId", checkoutAttemptId);
      const familyCharactersForOrder = form.familyCharacters
        .filter((character) =>
          Boolean(
            character.name.trim() ||
              character.relationshipLabel.trim() ||
              character.notes.trim() ||
              character.photoFile,
          ),
        )
        .slice(0, SUPPORTING_CHARACTER_LIMIT);
      payload.set("childName", form.childName);
      // Fully-custom hero contract. In production the server still fails closed
      // for non-child primary heroes unless the matching server env gate is on.
      payload.set("heroName", form.childName);
      payload.set("heroType", form.heroType || "child");
      if (form.childAge.trim()) payload.set("heroAgeOrStage", `${form.childAge.trim()} years old`);
      if (form.recipientName.trim()) payload.set("recipientName", form.recipientName.trim());
      if (form.recipientRelationship.trim()) {
        payload.set("recipientRelationship", form.recipientRelationship.trim());
      }
      if (form.heroPhotoFocusLabel.trim()) {
        payload.set("heroPhotoFocusLabel", form.heroPhotoFocusLabel.trim());
      }
      if (form.heroPhotoCropHint.trim()) {
        payload.set("heroPhotoCropHint", form.heroPhotoCropHint.trim());
      }
      payload.set("childAge", form.childAge);
      payload.set("theme", form.theme);
      payload.set("lesson", form.lesson);
      payload.set("occasion", form.occasion);
      payload.set("giftMessage", form.giftMessage);
      payload.set(
        "characterNotes",
        [
          form.characterNotes.trim(),
          form.customStoryMemory.trim()
            ? `Custom story memory / typed fallback: ${form.customStoryMemory.trim()}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
      payload.set(
        "familyCharacters",
        JSON.stringify(
          familyCharactersForOrder
            .map((character) => ({
              role: character.role,
              name: character.name,
              relationshipLabel: character.relationshipLabel,
              pronouns: "",
              notes: character.notes,
              isGiftRecipient: character.isGiftRecipient,
              appearsInStory: character.appearsInStory,
              photoFileName: character.photoFile?.name ?? null,
              mustInclude: character.mustInclude,
              mustIncludeOther: character.mustIncludeOther.trim(),
              focusPersonLabel: character.focusPersonLabel.trim() || null,
              cropHint: character.cropHint.trim() || null,
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
          description: form.characterNotes.trim(),
          mustInclude: form.mustInclude,
          mustIncludeOther: form.mustIncludeOther.trim(),
          likenessIntent: form.photoFile ? "match" : "storybook",
        }),
      );
      payload.set("bookFormat", form.bookFormat);
      payload.set("email", form.email);
      const referralCode = checkoutReferralCode();
      if (referralCode) payload.set("referralCode", referralCode);
      const checkoutTracking = checkoutTrackingFromSearchParams(new URLSearchParams(window.location.search));
      if (checkoutTracking?.cohort) payload.set("cohort", checkoutTracking.cohort);
      if (checkoutTracking?.invite) payload.set("invite", checkoutTracking.invite);
      const gaClientId = currentGaClientId();
      if (gaClientId) payload.set("gaClientId", gaClientId);
      if (form.photoFile) {
        payload.set("photo", form.photoFile);
      }
      if (STORY_UPLOAD_ENABLED && form.voiceFile) {
        payload.set("voice", form.voiceFile);
        payload.set("voiceConsent", form.voiceConsent ? "true" : "false");
        if (form.voiceSource) payload.set("voiceSource", form.voiceSource);
      }
      // Optional guided child stills. Appends only parent-approved still photos; no video.
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
        sessionStorage.removeItem(attemptStorageKey);
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
            We saved your details for{" "}
            {form.childName
              ? `${form.childName}'s magical story`
              : "your magical story"}
            . You&apos;ll finish at Stripe — your book starts once payment
            is complete.
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
        <div className="mx-auto max-w-6xl px-4 py-4 sm:px-6">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8c7b68]">
                  Step {currentStepIndex + 1} of {checkoutSteps.length}
                </p>
                <h1 className="font-serif text-2xl text-[#241914]">
                  {currentStep.title}
                </h1>
              </div>
              <button
                type="button"
                onClick={continueCurrentStep}
                className="rounded-full border border-[#cbbda4] bg-[#fff8ec] px-4 py-2 text-sm font-semibold text-[#241914] transition hover:border-deep-gold"
              >
                Continue
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8c7b68]">
              {checkoutSteps.map((step, index) => (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => {
                    if (!canNavigateToCheckoutStep(checkoutSteps, step.id)) return;
                    setCurrentStepId(step.id);
                    scrollToField(null, step.id);
                  }}
                  disabled={!canNavigateToCheckoutStep(checkoutSteps, step.id)}
                  aria-current={step.id === currentStep.id ? "step" : undefined}
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    step.id === currentStep.id
                      ? "border-deep-gold bg-[#fff8ec] text-[#241914]"
                      : step.status === "complete"
                        ? "border-[#cbbda4] bg-[#fff8ec] text-[#241914]"
                        : step.status === "needs_attention"
                          ? "border-[#a64c4c]/40 bg-[#a64c4c]/10 text-[#241914]"
                          : "border-[#d8c6a2] bg-[#f8f0dd] text-[#8c7b68]"
                  }`}
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border border-current text-[10px]">
                    {step.complete ? "✓" : index + 1}
                  </span>
                  {step.title}
                </button>
              ))}
            </div>
            {stepError && (
              <div
                role="alert"
                className="rounded-2xl border border-[#a64c4c]/30 bg-[#a64c4c]/10 px-4 py-3 text-sm text-[#241914]"
              >
                {stepError}
              </div>
            )}
          </div>
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
                  heroPhotoOperationRef.current += 1;
                  supportingPhotoOperationRef.current += 1;
                  setForm(emptyForm);
                  setSupportingCharacterDraft(null);
                  setEditingSupportingCharacterId(null);
                  setSupportingPhotoPendingId(null);
                  setGuidedFrames([]);
                  setGuidedConsent(false);
                  setShowGuidedPhotos(false);
                  setStepError(null);
                  setFieldErrors({});
                  setSubmitError(null);
                  setPhotoNotice(null);
                  setCurrentStepId("hero-details");
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

        {photoNotice && (
          <div className="mb-6 rounded-2xl border border-[#4f7d58]/25 bg-[#e8f2df] px-4 py-3 text-sm font-medium text-[#31543a]">
            {photoNotice}
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_340px]"
        >
          <div className="space-y-5">
            {/* ── 1. Theme ── */}
            <section
              ref={(node) => {
                registerStepRef("hero-details")(node);
                registerFieldRef("theme")(node);
              }}
              className={`${currentStepId !== "hero-details" ? "hidden" : ""} rounded-[1.75rem] border border-[#d8c6a2] bg-[#fff8ec] p-6 shadow-[0_18px_50px_-44px_rgba(31,26,22,0.5)] space-y-4`}
            >
              <div>
                <h2 className="font-serif text-2xl text-[#1f1a16]">
                  Choose a story direction
                </h2>
                <p className="mt-1 text-sm leading-6 text-[#695f54]">
                  Start with a fully custom story from your own memory, or use one of the ready adventure templates below.
                </p>
                <p className="mt-2 rounded-2xl border border-[#d8c6a2] bg-[#fffaf1] px-3 py-2 text-xs leading-5 text-[#695f54]">
                  Only a few things are required to start — story direction, child name, format, email, and either a hero photo or a written description. Everything else helps us make the proof better.
                </p>
              </div>

              {customStoryTheme && (
                <button
                  type="button"
                  onClick={() => {
                    const next = customStoryTheme.id;
                    set("theme", next);
                    if (next) track("story_selected", { theme: next });
                  }}
                  className={`w-full rounded-[1.5rem] border-2 p-4 text-left transition-all ${
                    form.theme === customStoryTheme.id
                      ? "border-deep-gold bg-deep-gold/15 ring-2 ring-deep-gold/30 shadow-sm"
                      : "border-[#d8c6a2] bg-[#fffaf1] hover:border-deep-gold/70 hover:bg-[#f8f0dd]"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl border border-[#d8c6a2] bg-[#f8f0dd] text-2xl">
                      {customStoryTheme.emoji}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="mb-1 inline-flex rounded-full bg-[#241914] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[#fff8ec]">
                        Fully custom
                      </span>
                      <span className="block font-serif text-xl font-semibold text-[#1f1a16]">
                        Custom Story
                      </span>
                      <span className="mt-1 block text-sm leading-6 text-[#695f54]">
                        Built from your written memory, optional voice note, family details, and story ideas.
                      </span>
                    </span>
                    {form.theme === customStoryTheme.id && (
                      <span className="rounded-full bg-deep-gold px-2.5 py-1 text-xs font-bold text-navy">
                        ✓ Added
                      </span>
                    )}
                  </div>
                </button>
              )}

              <div className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8a7663]">
                  Or pick a ready adventure template
                </p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {templateThemes.map((theme) => (
                    <button
                      key={theme.id}
                      type="button"
                      onClick={() => {
                        const next = theme.id;
                        set("theme", next);
                        if (next) track("story_selected", { theme: next });
                      }}
                      className={`flex items-start gap-3 rounded-2xl border-2 p-4 text-left transition-all ${
                        form.theme === theme.id
                          ? "border-deep-gold bg-deep-gold/15 ring-2 ring-deep-gold/30 shadow-sm"
                          : "border-[#dfd2b8] bg-[#fffaf1] hover:border-[#d8c6a2]"
                      }`}
                    >
                      <span className="flex-shrink-0 text-2xl">{theme.emoji}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-[#1f1a16]">
                          {theme.label}
                        </span>
                        <span className="mt-0.5 block text-xs leading-5 text-[#695f54]">
                          {theme.desc}
                        </span>
                      </span>
                      {form.theme === theme.id && (
                        <span className="ml-auto flex-shrink-0 rounded-full bg-deep-gold px-2 py-0.5 text-xs font-bold text-navy">
                          ✓
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            {isCustomStorySelected && (
              <section
                ref={registerStepRef("story")}
                className={`${currentStepId !== "story" ? "hidden" : ""} rounded-[1.75rem] border border-[#d8c6a2] bg-[#fff8ec] p-6 shadow-[0_18px_50px_-44px_rgba(31,26,22,0.5)] space-y-4`}
              >
                <div>
                  <h2 className="font-serif text-2xl text-[#1f1a16]">
                    Tell us the memory in your own words
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-[#695f54]">
                    Rambling is perfect. We turn it into the story. Choose the easiest way to send it now.
                  </p>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => set("customStorySourceMode", "audio")}
                    className={`rounded-2xl border-2 p-4 text-left transition ${
                      customStorySourceMode === "audio"
                        ? "border-deep-gold bg-deep-gold/15 ring-2 ring-deep-gold/30"
                        : "border-[#dfd2b8] bg-[#fffaf1] hover:border-[#d8c6a2]"
                    }`}
                  >
                    <span className="block text-sm font-bold text-[#1f1a16]">🎙️ Record or upload a voice note</span>
                    <span className="mt-1 block text-xs leading-5 text-[#8a7b6a]">
                      Record up to 3 minutes, or upload a voice memo or audio file.
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => set("customStorySourceMode", "written")}
                    className={`rounded-2xl border-2 p-4 text-left transition ${
                      customStorySourceMode === "written"
                        ? "border-deep-gold bg-deep-gold/15 ring-2 ring-deep-gold/30"
                        : "border-[#dfd2b8] bg-[#fffaf1] hover:border-[#d8c6a2]"
                    }`}
                  >
                    <span className="block text-sm font-bold text-[#1f1a16]">✍️ Prefer typing?</span>
                    <span className="mt-1 block text-xs leading-5 text-[#8a7b6a]">
                      Write the memory instead.
                    </span>
                  </button>
                </div>

                {STORY_UPLOAD_ENABLED && customStorySourceMode === "audio" && (
                  <VoiceRecorderSection
                    voiceFile={form.voiceFile}
                    voicePreviewUrl={form.voicePreviewUrl}
                    voiceSource={form.voiceSource}
                    voiceConsent={form.voiceConsent}
                    onVoiceChange={(file, previewUrl, source) =>
                      setForm((prev) => ({
                        ...prev,
                        theme: file && !prev.theme ? CUSTOM_STORY_THEME_ID : prev.theme,
                        customStorySourceMode: "audio",
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

                {customStorySourceMode === "written" && (
                  <div className="rounded-2xl border border-[#d8c6a2] bg-[#fffaf1] p-4">
                    <label
                      htmlFor="customStoryMemory"
                      className="block text-sm font-semibold text-[#1f1a16]"
                    >
                      Tell us the memory in your own words
                    </label>
                    <p className="mt-1 text-xs leading-5 text-[#8a7b6a]">
                      Rambling is perfect. Type the story idea, funny quote, family moment, or scene you want us to build from.
                    </p>
                    <textarea
                      id="customStoryMemory"
                      value={form.customStoryMemory}
                      onChange={(e) => set("customStoryMemory", e.target.value.slice(0, 1200))}
                      placeholder="e.g. Lukas and Dad found a tiny dinosaur footprint at the park, then Brody helped track it through the woods..."
                      rows={4}
                      className="mt-3 w-full resize-none rounded-2xl border-2 border-[#dfd2b8] bg-[#fffaf1] px-4 py-3 text-sm text-[#1f1a16] transition placeholder:text-[#9a8b7a] focus:border-[#a64c4c] focus:outline-none focus:ring-2 focus:ring-[#a64c4c]/30"
                    />
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[#8a7b6a]">
                      <span>{hasCustomStoryInput ? "✓ Custom Story source added" : "Add the memory before checkout feels complete."}</span>
                      <span>{form.customStoryMemory.length}/1200</span>
                    </div>
                  </div>
                )}

                {!customStorySourceMode && (
                  <p className="rounded-2xl border border-[#d8c6a2] bg-[#fffaf1] px-4 py-3 text-xs leading-5 text-[#8a7b6a]">
                    Voice notes stay private — used only to write your book, never to train anything, deleted on request. Written memories stay private to this order.
                  </p>
                )}
              </section>
            )}

            {!isCustomStorySelected && (
              <section
                ref={registerStepRef("story")}
                className={`${currentStepId !== "story" ? "hidden" : ""} rounded-[1.75rem] border border-[#d8c6a2] bg-[#fff8ec] p-6 shadow-[0_18px_50px_-44px_rgba(31,26,22,0.5)] space-y-4`}
              >
                <h2 className="font-serif text-2xl text-[#1f1a16]">Story details</h2>
                <p className="text-sm leading-6 text-[#695f54]">
                  Your selected adventure is ready. Extra lesson, occasion, and dedication details are optional and can be reviewed by going back to Hero details.
                </p>
                <div className="rounded-2xl border border-[#cfe0d8] bg-[#eef4f1] px-4 py-3 text-sm font-semibold text-[#35564d]">
                  ✓ No additional story information is required.
                </div>
              </section>
            )}

            {/* ── 2. Hero / main character details ── */}
            <section className={`${currentStepId !== "hero-details" ? "hidden" : ""} rounded-[1.75rem] border border-[#d8c6a2] bg-[#fff8ec] p-6 shadow-[0_18px_50px_-44px_rgba(31,26,22,0.5)] space-y-5`}>
              <div>
                <h2 className="font-serif text-2xl text-[#1f1a16]">
                  Who this story celebrates
                </h2>
                <p className="mt-1 text-sm text-[#695f54]">
                  {PRIMARY_HERO_BETA_ENABLED
                    ? "Choose who leads the book. Some story types are available by review only — we’ll confirm the recipient details and reference photo before production. Every paid order is still proof-reviewed before printing."
                    : "Tell us about the main hero of the book. Right now every book stars a child as the hero — you can add parents, grandparents, siblings, and pets as co-heroes and family below. Adult-led hero stories are coming soon."}
                </p>
              </div>

              {PRIMARY_HERO_BETA_ENABLED && (
                <div>
                  <label className="block text-sm font-semibold text-[#1f1a16] mb-2">
                    Primary hero type <span className="text-red-400">*</span>
                  </label>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {PRIMARY_HERO_TYPES.map((type) => (
                      <button
                        key={type.id}
                        type="button"
                        onClick={() => set("heroType", type.id)}
                        className={`rounded-2xl border-2 px-3 py-2 text-left text-sm font-semibold transition ${
                          form.heroType === type.id
                            ? "border-deep-gold bg-deep-gold/15 text-navy ring-2 ring-deep-gold/30"
                            : "border-[#dfd2b8] text-[#695f54] hover:border-[#d8c6a2]"
                        }`}
                      >
                        <span className="block">{type.label}</span>
                        <span className="block text-[11px] font-normal text-[#8a7b6a]">{type.helper}</span>
                      </button>
                    ))}
                  </div>
                  {form.heroType !== "child" && (
                    <p className="mt-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900">
                      This story type is currently available by review only. We&apos;ll confirm the recipient details and reference photo before production.
                    </p>
                  )}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="childName"
                    className="block text-sm font-semibold text-[#1f1a16] mb-1.5"
                  >
                    Main hero&apos;s name <span className="text-red-400">*</span>
                  </label>
                  <input
                    ref={registerFieldRef("childName")}
                    id="childName"
                    type="text"
                    value={form.childName}
                    onChange={(e) => set("childName", e.target.value)}
                    placeholder={PRIMARY_HERO_BETA_ENABLED ? "e.g., Emma, Dad, Grandpa Joe, the Rivera family" : "e.g., Emma, Liam, Sofia"}
                    required
                    className={`w-full px-4 py-3 border-2 rounded-2xl focus:outline-none focus:border-[#a64c4c] focus:ring-2 focus:ring-[#a64c4c]/30 transition text-[#1f1a16] bg-[#fffaf1] ${
                      fieldErrors.childName ? "border-[#a64c4c]" : "border-[#dfd2b8]"
                    }`}
                  />
                </div>
                <div>
                  <label
                    htmlFor="childAge"
                    className="block text-sm font-semibold text-[#1f1a16] mb-1.5"
                  >
                    {form.heroType === "child" ? "Age" : "Age / life stage"}{" "}
                    <span className="text-[#8a7b6a] font-normal">
                      (optional)
                    </span>
                  </label>
                  {form.heroType === "child" ? (
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
                  ) : (
                    <input
                      id="childAge"
                      type="text"
                      value={form.childAge}
                      onChange={(e) => set("childAge", e.target.value.slice(0, 40))}
                      placeholder="e.g., dad, grandma, 40s, family group"
                      className="w-full px-4 py-3 border-2 border-[#dfd2b8] rounded-2xl focus:outline-none focus:border-[#a64c4c] focus:ring-2 focus:ring-[#a64c4c]/30 transition text-[#1f1a16] bg-[#fffaf1]"
                    />
                  )}
                </div>
              </div>

              {/* Book recipient / audience — optional fully-custom context */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="recipientName"
                    className="block text-sm font-semibold text-[#1f1a16] mb-1.5"
                  >
                    Who is the book for?{" "}
                    <span className="text-[#8a7b6a] font-normal">(optional)</span>
                  </label>
                  <input
                    id="recipientName"
                    type="text"
                    value={form.recipientName}
                    onChange={(e) => set("recipientName", e.target.value)}
                    placeholder="e.g., Emma, our whole family"
                    maxLength={80}
                    className="w-full px-4 py-3 border-2 border-[#dfd2b8] rounded-2xl focus:outline-none focus:border-[#a64c4c] focus:ring-2 focus:ring-[#a64c4c]/30 transition text-[#1f1a16] bg-[#fffaf1]"
                  />
                </div>
                <div>
                  <label
                    htmlFor="recipientRelationship"
                    className="block text-sm font-semibold text-[#1f1a16] mb-1.5"
                  >
                    Hero&apos;s relationship to them{" "}
                    <span className="text-[#8a7b6a] font-normal">(optional)</span>
                  </label>
                  <input
                    id="recipientRelationship"
                    type="text"
                    value={form.recipientRelationship}
                    onChange={(e) => set("recipientRelationship", e.target.value)}
                    placeholder="e.g., Grandpa to Emma, Mom to Lukas"
                    maxLength={80}
                    className="w-full px-4 py-3 border-2 border-[#dfd2b8] rounded-2xl focus:outline-none focus:border-[#a64c4c] focus:ring-2 focus:ring-[#a64c4c]/30 transition text-[#1f1a16] bg-[#fffaf1]"
                  />
                </div>
              </div>

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
                  placeholder="e.g. birthday, first day of school, big sibling gift"
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

            {/* ── 2.5 Hero appearance ── */}
            <section
              ref={registerStepRef("hero-appearance")}
              className={`${currentStepId !== "hero-appearance" ? "hidden" : ""} rounded-[1.75rem] border border-[#d8c6a2] bg-[#fff8ec] p-6 shadow-[0_18px_50px_-44px_rgba(31,26,22,0.5)] space-y-4`}
            >
              <div>
                <h2 className="font-serif text-2xl text-[#1f1a16] mb-1">
                  How should the hero look?
                </h2>
                <p className="text-sm text-[#695f54]">
                  {form.photoFile
                    ? "We'll use the uploaded photo as the hero's visual reference."
                    : "No photo is required. Describe the hero and we'll draw them as a storybook character."}
                </p>
              </div>

              <div className="rounded-2xl border border-[#cfe0d8] bg-[#eef4f1] px-4 py-3 text-sm font-semibold text-[#35564d]">
                {form.photoFile
                  ? "✓ Drawn to look like the uploaded photo"
                  : "Drawn as a storybook character from your description"}
              </div>

              {form.photoFile ? (
                <details className="rounded-2xl border border-[#dfd2b8] bg-[#fffaf1] p-4">
                  <summary className="cursor-pointer text-sm font-semibold text-[#1f1a16]">
                    Add anything the photo doesn&apos;t show (optional)
                  </summary>
                  <textarea
                    value={form.characterNotes}
                    onChange={(e) => set("characterNotes", e.target.value)}
                    placeholder="Examples: freckles, favorite hoodie color, curly bangs, braces, or another important detail"
                    rows={3}
                    maxLength={240}
                    className="mt-3 w-full resize-none rounded-2xl border-2 border-[#dfd2b8] bg-[#fffaf1] px-4 py-3 text-sm text-[#1f1a16] transition focus:border-[#a64c4c] focus:outline-none focus:ring-2 focus:ring-[#a64c4c]/30"
                  />
                </details>
              ) : (
                <div>
                  <label className="mb-1.5 block text-sm font-semibold text-[#1f1a16]">
                    Describe the hero <span className="text-[#a64c4c]">(required without a photo)</span>
                  </label>
                  <textarea
                    ref={registerFieldRef("characterNotes")}
                    value={form.characterNotes}
                    onChange={(e) => set("characterNotes", e.target.value)}
                    placeholder="Example: 6 years old, warm brown skin, short curly dark hair, bright green hoodie"
                    rows={3}
                    maxLength={240}
                    required
                    className={`w-full resize-none rounded-2xl border-2 bg-[#fffaf1] px-4 py-3 text-sm text-[#1f1a16] transition focus:border-[#a64c4c] focus:outline-none focus:ring-2 focus:ring-[#a64c4c]/30 ${
                      fieldErrors.characterNotes ? "border-[#a64c4c]" : "border-[#dfd2b8]"
                    }`}
                  />
                  <p className="mt-1 text-xs text-[#8a7b6a]">
                    We&apos;ll match the details you provide, but not a real face.
                  </p>
                </div>
              )}

              <div>
                <p className="mb-2 text-sm font-semibold text-[#1f1a16]">
                  Must include <span className="font-normal text-[#8a7b6a]">(optional)</span>
                </p>
                <div className="flex flex-wrap gap-2">
                  {MUST_INCLUDE_OPTIONS.map((option) => {
                    const selected = form.mustInclude.includes(option.id);
                    return (
                      <button
                        key={option.id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() =>
                          setForm((prev) => ({
                            ...prev,
                            mustInclude: selected
                              ? prev.mustInclude.filter((item) => item !== option.id)
                              : [...prev.mustInclude, option.id],
                          }))
                        }
                        className={`rounded-full border-2 px-3 py-2 text-sm font-semibold transition ${
                          selected
                            ? "border-deep-gold bg-deep-gold/15 text-navy"
                            : "border-[#dfd2b8] text-[#695f54] hover:border-[#a64c4c]/60"
                        }`}
                      >
                        {selected ? "✓ " : ""}{option.label}
                      </button>
                    );
                  })}
                </div>
                {form.mustInclude.includes("custom-detail") && (
                  <input
                    type="text"
                    value={form.mustIncludeOther}
                    onChange={(e) => set("mustIncludeOther", e.target.value.slice(0, 80))}
                    placeholder="Another must-include detail"
                    className="mt-3 w-full rounded-2xl border-2 border-[#dfd2b8] bg-[#fffaf1] px-4 py-3 text-sm text-[#1f1a16] transition focus:border-[#a64c4c] focus:outline-none focus:ring-2 focus:ring-[#a64c4c]/30"
                  />
                )}
              </div>
            </section>

            {/* ── 2.75 Supporting characters ── */}
            <section
              ref={registerStepRef("people")}
              className={`${currentStepId !== "people" ? "hidden" : ""} rounded-[1.75rem] border border-[#d8c6a2] bg-[#fff8ec] p-6 shadow-[0_18px_50px_-44px_rgba(31,26,22,0.5)] space-y-4`}
            >
              <div>
                <h2 className="font-serif text-2xl text-[#1f1a16] mb-1">
                  People, pets, and family details
                </h2>
                <p className="text-sm text-[#695f54]">
                  Add co-heroes, family members, gift recipients, or pets for the
                  story text and scene notes. Human drafts need a name and either
                  appearance details or a reference photo before they can be saved.
                  Pets still need a name, but photo and notes stay optional.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                {SUPPORTING_CHARACTER_PRESETS.map((preset) => (
                  <button
                    key={preset.role}
                    type="button"
                    onClick={() => addSupportingCharacter(preset)}
                    disabled={Boolean(supportingCharacterDraft) || form.familyCharacters.length >= SUPPORTING_CHARACTER_LIMIT}
                    className="rounded-full border-2 border-[#dfd2b8] px-3 py-2 text-sm font-semibold text-[#695f54] transition hover:border-[#a64c4c]/60 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    + {preset.label}
                  </button>
                ))}
              </div>

              {supportingCharacterDraft && (
                <div className="rounded-2xl border border-[#a64c4c]/25 bg-[#fffaf1] p-4">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-bold text-[#1f1a16]">
                        {editingSupportingCharacterId ? "Edit person" : "Add person"}
                      </p>
                      <p className="text-xs leading-5 text-[#8a7b6a]">
                        Save or cancel this draft before adding another person.
                      </p>
                    </div>
                    <span className="rounded-full border border-[#dfd2b8] bg-[#f8f0dd] px-3 py-1 text-xs font-semibold text-[#695f54]">
                      Draft open
                    </span>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1.5 block text-sm font-semibold text-[#1f1a16]">
                        Name
                      </label>
                      <input
                        ref={registerFieldRef("supportingCharacter.name")}
                        type="text"
                        value={supportingCharacterDraft.name}
                        onChange={(e) => updateSupportingCharacter(supportingCharacterDraft.id, { name: e.target.value })}
                        placeholder={supportingCharacterDraft.role === "pet" ? "e.g., Brody" : "e.g., Alexy"}
                        maxLength={80}
                        className={`w-full rounded-2xl border-2 bg-[#fffaf1] px-4 py-3 text-[#1f1a16] transition focus:border-[#a64c4c] focus:outline-none focus:ring-2 focus:ring-[#a64c4c]/30 ${
                          fieldErrors["supportingCharacter.name"] ? "border-[#a64c4c]" : "border-[#dfd2b8]"
                        }`}
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-sm font-semibold text-[#1f1a16]">
                        Who are they in the story?
                      </label>
                      <input
                        type="text"
                        value={supportingCharacterDraft.relationshipLabel}
                        onChange={(e) => updateSupportingCharacter(supportingCharacterDraft.id, { relationshipLabel: e.target.value })}
                        placeholder="Dad, Grandma, big sister, family dog..."
                        maxLength={80}
                        className="w-full rounded-2xl border-2 border-[#dfd2b8] bg-[#fffaf1] px-4 py-3 text-[#1f1a16] transition focus:border-[#a64c4c] focus:outline-none focus:ring-2 focus:ring-[#a64c4c]/30"
                      />
                    </div>
                  </div>

                  <label className="mt-3 block text-sm font-semibold text-[#1f1a16]">
                    {supportingCharacterDraft.role === "pet" ? "Pet details" : "Appearance details"}
                  </label>
                  <textarea
                    value={supportingCharacterDraft.notes}
                    onChange={(e) => updateSupportingCharacter(supportingCharacterDraft.id, { notes: e.target.value })}
                    placeholder={
                      supportingCharacterDraft.role === "pet"
                        ? PET_NOTES_PLACEHOLDER
                        : "Hair, skin tone, glasses, clothing, size, or other visual details if you are not uploading a photo"
                    }
                    rows={2}
                    maxLength={180}
                    className="mt-1.5 w-full resize-none rounded-2xl border-2 border-[#dfd2b8] bg-[#fffaf1] px-4 py-3 text-sm text-[#1f1a16] transition focus:border-[#a64c4c] focus:outline-none focus:ring-2 focus:ring-[#a64c4c]/30"
                  />

                  <label className="mt-3 flex items-center gap-3 rounded-2xl border border-[#dfd2b8] bg-[#fffaf1] px-4 py-3 text-sm font-semibold text-[#1f1a16]">
                    <input
                      type="checkbox"
                      checked={supportingCharacterDraft.isGiftRecipient}
                      onChange={(e) => updateSupportingCharacter(supportingCharacterDraft.id, {
                        isGiftRecipient: e.target.checked,
                      })}
                    />
                    This person is the gift recipient
                  </label>

                  <div className="mt-3">
                    <p className="mb-2 text-sm font-semibold text-[#1f1a16]">
                      Must include <span className="font-normal text-[#8a7b6a]">(optional)</span>
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {MUST_INCLUDE_OPTIONS.map((option) => {
                        const selected = supportingCharacterDraft.mustInclude.includes(option.id);
                        return (
                          <button
                            key={option.id}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => updateSupportingCharacter(supportingCharacterDraft.id, {
                              mustInclude: selected
                                ? supportingCharacterDraft.mustInclude.filter((item) => item !== option.id)
                                : [...supportingCharacterDraft.mustInclude, option.id],
                            })}
                            className={`rounded-full border-2 px-3 py-2 text-xs font-semibold transition ${
                              selected
                                ? "border-deep-gold bg-deep-gold/15 text-navy"
                                : "border-[#dfd2b8] text-[#695f54] hover:border-[#a64c4c]/60"
                            }`}
                          >
                            {selected ? "✓ " : ""}{option.label}
                          </button>
                        );
                      })}
                    </div>
                    {supportingCharacterDraft.mustInclude.includes("custom-detail") && (
                      <input
                        type="text"
                        value={supportingCharacterDraft.mustIncludeOther}
                        onChange={(e) => updateSupportingCharacter(supportingCharacterDraft.id, {
                          mustIncludeOther: e.target.value.slice(0, 80),
                        })}
                        placeholder="Another must-include detail"
                        className="mt-3 w-full rounded-2xl border-2 border-[#dfd2b8] bg-[#fffaf1] px-4 py-3 text-sm text-[#1f1a16] transition focus:border-[#a64c4c] focus:outline-none focus:ring-2 focus:ring-[#a64c4c]/30"
                      />
                    )}
                  </div>

                  <div className="mt-3 rounded-2xl border border-[#dfd2b8] bg-[#f8f0dd] p-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-[#1f1a16]">
                          Reference photo
                        </p>
                        <p className="text-xs leading-5 text-[#8a7b6a]">
                          Human photos are proof-team references only, not guaranteed direct likeness conditioning.
                        </p>
                      </div>
                      {supportingCharacterDraft.photoFile && (
                        <button
                          type="button"
                          onClick={() => {
                            supportingPhotoOperationRef.current += 1;
                            setSupportingPhotoPendingId(null);
                            updateSupportingCharacter(supportingCharacterDraft.id, { photoFile: null, photoDataUrl: null });
                          }}
                          className="rounded-full border border-[#dfd2b8] bg-[#fffaf1] px-3 py-1 text-xs font-semibold text-[#695f54] transition hover:border-[#a64c4c]/60 hover:text-[#a64c4c]"
                        >
                          Remove photo
                        </button>
                      )}
                    </div>

                    {supportingCharacterDraft.photoDataUrl ? (
                      <div className="grid gap-3 sm:grid-cols-[96px_1fr] sm:items-center">
                        <div className="overflow-hidden rounded-xl border border-[#d8c6a2] bg-[#fffaf1]">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={supportingCharacterDraft.photoDataUrl}
                            alt="Supporting character reference"
                            className="h-24 w-full object-cover"
                          />
                        </div>
                        <div className="min-w-0 text-sm text-[#35564d]">
                          <p className="truncate font-semibold">
                            {supportingCharacterDraft.photoFile?.name}
                          </p>
                          <p className="text-xs text-[#5f766f]">
                            Saved with this person for operator review.
                          </p>
                        </div>
                        <div className="space-y-2 sm:col-span-2">
                          <p className="text-xs font-semibold text-[#1f1a16]">
                            If this photo has multiple people, tell us who to use and where they are.
                          </p>
                          <div className="grid gap-2 sm:grid-cols-2">
                            <input
                              type="text"
                              value={supportingCharacterDraft.focusPersonLabel}
                              onChange={(e) => updateSupportingCharacter(supportingCharacterDraft.id, {
                                focusPersonLabel: e.target.value.slice(0, 120),
                              })}
                              placeholder="Who to use (e.g., Grandpa on the left)"
                              className="w-full rounded-xl border-2 border-[#dfd2b8] bg-[#fffaf1] px-3 py-2 text-sm text-[#1f1a16] transition focus:border-[#a64c4c] focus:outline-none focus:ring-2 focus:ring-[#a64c4c]/30"
                            />
                            <select
                              value={supportingCharacterDraft.cropHint}
                              onChange={(e) => updateSupportingCharacter(supportingCharacterDraft.id, {
                                cropHint: e.target.value,
                              })}
                              className="w-full rounded-xl border-2 border-[#dfd2b8] bg-[#fffaf1] px-3 py-2 text-sm text-[#1f1a16] transition focus:border-[#a64c4c] focus:outline-none focus:ring-2 focus:ring-[#a64c4c]/30"
                            >
                              <option value="">Where in the photo? (optional)</option>
                              <option value="only-person">Only one person</option>
                              <option value="left">Left</option>
                              <option value="center">Center</option>
                              <option value="right">Right</option>
                              <option value="top-left">Top-left</option>
                              <option value="top-right">Top-right</option>
                              <option value="bottom-left">Bottom-left</option>
                              <option value="bottom-right">Bottom-right</option>
                            </select>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="grid gap-2 sm:grid-cols-2">
                        <label className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-[#d8c6a2] bg-[#fffaf1] px-4 py-4 text-center text-sm font-semibold text-[#695f54] transition hover:border-[#a64c4c]/60 hover:bg-[#f5ead2]">
                          <span>Use camera roll</span>
                          <span className="text-xs font-normal text-[#8a7b6a]">
                            JPG/PNG/WebP
                          </span>
                          <input
                            type="file"
                            accept={CHECKOUT_PHOTO_ACCEPT_ATTR}
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) processSupportingCharacterPhoto(supportingCharacterDraft.id, f);
                              e.currentTarget.value = "";
                            }}
                          />
                        </label>
                        <label className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-[#d8c6a2] bg-[#fffaf1] px-4 py-4 text-center text-sm font-semibold text-[#695f54] transition hover:border-[#a64c4c]/60 hover:bg-[#f5ead2]">
                          <span>Take a new picture</span>
                          <span className="text-xs font-normal text-[#8a7b6a]">
                            Still photo only
                          </span>
                          <input
                            type="file"
                            accept={CHECKOUT_PHOTO_ACCEPT_ATTR}
                            capture="user"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) processSupportingCharacterPhoto(supportingCharacterDraft.id, f);
                              e.currentTarget.value = "";
                            }}
                          />
                        </label>
                      </div>
                    )}
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={saveSupportingCharacter}
                      disabled={supportingPhotoPendingId === supportingCharacterDraft.id}
                      className="rounded-full bg-deep-gold px-4 py-2 text-sm font-bold text-navy disabled:cursor-wait disabled:opacity-50"
                    >
                      {supportingPhotoPendingId === supportingCharacterDraft.id ? "Processing photo…" : "Save person"}
                    </button>
                    <button
                      type="button"
                      onClick={cancelSupportingCharacter}
                      className="rounded-full border border-[#dfd2b8] px-4 py-2 text-sm font-semibold text-[#695f54]"
                    >
                      {editingSupportingCharacterId ? "Cancel edit" : "Cancel"}
                    </button>
                  </div>
                </div>
              )}

              {form.familyCharacters.length > 0 && (
                <div className="space-y-3">
                  {form.familyCharacters.map((character, index) => {
                    const needsAttention = supportingCharacterDraftMissingFields(character).length > 0;
                    return (
                      <div
                        key={character.id}
                        className="rounded-2xl border border-[#dfd2b8] bg-[#fffaf1] p-4"
                      >
                        <div className="mb-3 flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-bold text-[#1f1a16]">
                              {needsAttention ? "Needs attention" : "✓ Added"} · Character {index + 1}
                              {character.name || character.relationshipLabel
                                ? `: ${character.name || character.relationshipLabel}`
                                : ""}
                            </p>
                            <p className="text-xs leading-5 text-[#8a7b6a]">
                              {character.role === "pet"
                                ? "Pets only require a name to stay complete."
                                : "Humans stay complete when they have a name and either appearance details or a reference photo."}
                            </p>
                          </div>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => editSupportingCharacter(character.id)}
                              disabled={Boolean(supportingCharacterDraft)}
                              className="rounded-full border border-[#dfd2b8] px-3 py-1 text-xs font-semibold text-[#695f54] transition hover:border-[#a64c4c]/60 hover:text-[#a64c4c] disabled:opacity-40"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => removeSupportingCharacter(character.id)}
                              className="rounded-full border border-[#dfd2b8] px-3 py-1 text-xs font-semibold text-[#695f54] transition hover:border-[#a64c4c]/60 hover:text-[#a64c4c]"
                            >
                              Remove
                            </button>
                          </div>
                        </div>

                        <div className="grid gap-2 text-sm text-[#695f54] sm:grid-cols-2">
                          <p><span className="font-semibold text-[#1f1a16]">Role:</span> {character.relationshipLabel || character.role || "Not set"}</p>
                          <p><span className="font-semibold text-[#1f1a16]">Name:</span> {character.name || "Missing"}</p>
                          <p><span className="font-semibold text-[#1f1a16]">Appearance details:</span> {character.notes.trim() ? "Added" : character.role === "pet" ? "Optional" : "Missing"}</p>
                          <p><span className="font-semibold text-[#1f1a16]">Reference photo:</span> {character.photoFile ? "Added" : "None"}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* ── 3. Hero photo ── */}
            <section className={`${currentStepId !== "hero-appearance" ? "hidden" : ""} rounded-[1.75rem] border border-[#d8c6a2] bg-[#fff8ec] p-6 shadow-[0_18px_50px_-44px_rgba(31,26,22,0.5)] space-y-4`}>
              <div>
                <h2 className="font-serif text-2xl text-[#1f1a16] mb-1">
                  Add one clear photo for the main character
                </h2>
                <p className="text-sm leading-6 text-[#695f54]">
                  Optional, but best for the closest hero likeness. If you skip it, we&apos;ll use the written description above and hand-review the proof before print.
                </p>
              </div>
              <div className="inline-flex w-fit rounded-full border border-[#d8c6a2] bg-[#fffaf1] px-3 py-1 text-xs font-semibold text-[#695f54]">
                {form.photoFile ? "Main character photo added" : "No hero photo required"}
              </div>

              {/* Sample teaser — shown before upload */}
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
                    Uploaded photo → storybook illustration · hand-reviewed before print
                  </p>
                </div>
              )}

              {/* Upload zone / preview */}
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
                        heroPhotoOperationRef.current += 1;
                        setForm((prev) => ({
                          ...prev,
                          photoFile: null,
                          photoDataUrl: null,
                        }));
                      }}
                      className="absolute top-2 right-2 bg-[#fffaf1]/90 hover:bg-[#fffaf1] text-[#1f1a16] text-xs font-semibold px-3 py-1.5 rounded-full shadow transition"
                    >
                      Change Photo
                    </button>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-[#35564d] bg-[#eef4f1] border border-[#cfe0d8] rounded-lg px-3 py-2">
                    <span>✅</span>
                    <span className="font-medium">{form.photoFile?.name}</span>
                    <span className="text-[#35564d] text-xs ml-auto">
                      Ready for magic
                    </span>
                  </div>
                  {/* Multi-person disambiguation for the main hero photo (text MVP) */}
                  <div className="space-y-2 rounded-2xl border border-[#dfd2b8] bg-[#f8f0dd] p-3">
                    <p className="text-xs font-semibold text-[#1f1a16]">
                      If this photo has multiple people, tell us who the hero is and where they are.
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <input
                        type="text"
                        value={form.heroPhotoFocusLabel}
                        onChange={(e) =>
                          set("heroPhotoFocusLabel", e.target.value.slice(0, 120))
                        }
                        placeholder={`Who is the hero? (e.g., ${form.childName || "Emma"} in the middle)`}
                        className="w-full rounded-xl border-2 border-[#dfd2b8] bg-[#fffaf1] px-3 py-2 text-sm text-[#1f1a16] transition focus:border-[#a64c4c] focus:outline-none focus:ring-2 focus:ring-[#a64c4c]/30"
                      />
                      <select
                        value={form.heroPhotoCropHint}
                        onChange={(e) => set("heroPhotoCropHint", e.target.value)}
                        className="w-full rounded-xl border-2 border-[#dfd2b8] bg-[#fffaf1] px-3 py-2 text-sm text-[#1f1a16] transition focus:border-[#a64c4c] focus:outline-none focus:ring-2 focus:ring-[#a64c4c]/30"
                      >
                        <option value="">Where in the photo? (optional)</option>
                        <option value="only-person">Only one person</option>
                        <option value="left">Left</option>
                        <option value="center">Center</option>
                        <option value="right">Right</option>
                        <option value="top-left">Top-left</option>
                        <option value="top-right">Top-right</option>
                        <option value="bottom-left">Bottom-left</option>
                        <option value="bottom-right">Bottom-right</option>
                      </select>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={handleDrop}
                    onClick={() => photoInputRef.current?.click()}
                    className={`flex cursor-pointer items-start gap-3 rounded-2xl border-2 p-4 text-left transition-all ${
                      dragOver
                        ? "border-[#a64c4c] bg-[#a64c4c]/10 scale-[1.01]"
                        : "border-[#dfd2b8] bg-[#fffaf1] hover:border-[#d8c6a2] hover:bg-[#f8f0dd]"
                    }`}
                  >
                    <input
                      ref={photoInputRef}
                      type="file"
                      accept={CHECKOUT_PHOTO_ACCEPT_ATTR}
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) processPhoto(f);
                        e.currentTarget.value = "";
                      }}
                    />
                    <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl border border-[#d8c6a2] bg-[#f8f0dd] text-2xl">
                      {dragOver ? "🌟" : "📸"}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-bold text-[#1f1a16]">
                        {dragOver ? "Drop it here" : "Use camera roll"}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-[#8a7b6a]">
                        Choose an existing photo from your phone.
                      </span>
                    </span>
                  </div>

                  <label className="flex cursor-pointer items-start gap-3 rounded-2xl border-2 border-[#dfd2b8] bg-[#fffaf1] p-4 text-left transition hover:border-[#d8c6a2] hover:bg-[#f8f0dd]">
                    <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl border border-[#d8c6a2] bg-[#f8f0dd] text-2xl">🤳</span>
                    <span className="min-w-0">
                      <span className="block text-sm font-bold text-[#1f1a16]">Take a new picture</span>
                      <span className="mt-1 block text-xs leading-5 text-[#8a7b6a]">
                        Open your camera for a still photo.
                      </span>
                    </span>
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
                </div>
              )}

              <p className="text-xs text-center leading-5 text-[#8a7b6a]">
                🔒 Photos stay private — used only to illustrate your book, never to train AI. You can review before print.
              </p>

              {guidedCaptureEnabled && (
                <div className="space-y-3">
                  <button
                    type="button"
                    onClick={() => setShowGuidedPhotos((open) => !open)}
                    aria-expanded={showGuidedPhotos}
                    className="w-full rounded-2xl border border-[#d8c6a2] bg-[#fffaf1] px-4 py-3 text-left transition hover:border-[#a64c4c]/60 hover:bg-[#f8f0dd]"
                  >
                    <span className="flex items-start justify-between gap-3">
                      <span>
                        <span className="block text-sm font-bold text-[#1f1a16]">
                          Want an even better likeness? Take guided photos
                        </span>
                        <span className="mt-1 block text-xs leading-5 text-[#8a7b6a]">
                          {guidedPhotoSummary}
                        </span>
                      </span>
                      <span className="rounded-full border border-[#d8c6a2] bg-[#f8f0dd] px-2 py-0.5 text-xs font-bold text-[#695f54]">
                        {showGuidedPhotos ? "Hide" : "Show"}
                      </span>
                    </span>
                  </button>

                  {showGuidedPhotos && (
                    <GuidedPhotoCapture
                      heroName={form.childName}
                      frames={guidedFrames}
                      consent={guidedConsent}
                      onConsentChange={setGuidedConsent}
                      onFramesChange={setGuidedFrames}
                    />
                  )}
                </div>
              )}
            </section>

            {/* ── 4. Format + Delivery ── */}
            <section
              ref={registerStepRef("review")}
              className={`${currentStepId !== "review" ? "hidden" : ""} rounded-[1.75rem] border border-[#d8c6a2] bg-[#fff8ec] p-6 shadow-[0_18px_50px_-44px_rgba(31,26,22,0.5)] space-y-4`}
            >
              <h2 className="font-serif text-2xl text-[#1f1a16]">
                Choose your format
              </h2>
              {showFathersDayReminder && (
                <div className="rounded-2xl border border-[#a64c4c]/25 bg-[#a64c4c]/10 px-4 py-3 text-sm leading-6 text-[#1f1a16]">
                  <strong>Father&apos;s Day order-by date: {fathersDay.safeOrderDateLabel}.</strong>{" "}
                  Digital arrives same-day after proof approval; printed books depend on proof timing and carrier delivery.
                </div>
              )}
              <div className="rounded-lg border border-deep-gold/30 bg-deep-gold/5 px-3 py-2 text-xs text-forest">
                <span className="font-semibold">🎟️ Promo code?</span> {PROMO_CODE_HELP}
              </div>
              <div className="space-y-3">
                {FORMATS.map((fmt) => (
                  <button
                    key={fmt.id}
                    ref={fmt.id === DEFAULT_BOOK_FORMAT ? registerFieldRef("bookFormat") : undefined}
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
                          {fmt.delivery}
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

            {/* ── 5. Email + Preview Promise ── */}
            <section className={`${currentStepId !== "review" ? "hidden" : ""} rounded-[1.75rem] border border-[#d8c6a2] bg-[#fff8ec] p-6 shadow-[0_18px_50px_-44px_rgba(31,26,22,0.5)] space-y-4`}>
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
                ref={registerFieldRef("email")}
                id="email"
                type="email"
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
                placeholder="your@email.com"
                required
                className={`w-full px-4 py-3 border-2 rounded-2xl focus:outline-none focus:border-[#a64c4c] focus:ring-2 focus:ring-[#a64c4c]/30 transition text-[#1f1a16] bg-[#fffaf1] ${
                  fieldErrors.email ? "border-[#a64c4c]" : "border-[#dfd2b8]"
                }`}
              />
              <div className="rounded-2xl border border-[#cfe0d8] bg-[#eef4f1] px-4 py-3 text-sm text-[#35564d]">
                ✨ {PRINT_PREVIEW_PROMISE}
              </div>
              {missingSupportingDescriptionLabels.length > 0 && (
                <div className="rounded-2xl border border-[#a64c4c]/25 bg-[#a64c4c]/10 px-4 py-3 text-sm leading-6 text-[#1f1a16]">
                  Add a few written details for {missingSupportingDescriptionLabels.join(", ")} before payment if you aren&apos;t uploading a supporting photo.
                </div>
              )}

            </section>

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
                    starring {form.childName || "your child"}
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
                      {form.photoFile ? "Main photo added" : "Add before proof"}
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
                        {form.familyCharacters.length} included
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
                    Usually in {PROOF_TURNAROUND_WINDOW}, you get a private link to review every page before anything prints.{" "}
                    {PROOF_REVIEW_ASSURANCE} {PROOF_VOLUME_NOTE}
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
                    Print books ship after approval; digital books are delivered
                    right away.
                  </span>
                </li>
              </ol>
            </section>

            <div className="space-y-3 pb-10">
              {/* Disabled-CTA reason. Listed before the button so a screen
                  reader / sighted reviewer immediately knows WHY the button
                  is greyed instead of guessing. Computed from the same
                  inputs that gate isReadyToPay. */}
              {!isReadyToPay && !isSubmitting && (
                <div className="rounded-xl border border-deep-gold/40 bg-deep-gold/10 px-3 py-3 text-xs text-navy">
                  <p className="text-center font-medium">
                    Finish these before continuing to payment, including the hero photo or description when it is still missing.
                  </p>
                  <div className="mt-2 flex flex-wrap justify-center gap-2">
                    {paymentBlockers.map((blocker) => {
                      const [stepTitle, fieldLabel] = blocker.split(": ");
                      const targetStep = checkoutSteps.find((step) => step.title === stepTitle);
                      return (
                        <button
                          key={blocker}
                          type="button"
                          onClick={() => {
                            if (targetStep) {
                              setCurrentStepId(targetStep.id);
                              scrollToField(targetStep.firstInvalidField, targetStep.id);
                            }
                          }}
                          className="rounded-full border border-deep-gold/40 bg-[#fff8ec] px-3 py-1.5 text-left font-semibold text-navy"
                        >
                          {fieldLabel ?? blocker}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {/* Inline submit error. Shows the SPECIFIC server reason and
                  reassures the customer nothing was saved or charged — so a
                  failed submission (e.g. a voice-save abort) never looks like
                  it went through. */}
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
                  <p className="mt-2 text-xs font-medium text-red-700">
                    If the issue continues, email{" "}
                    <a
                      href="mailto:support@herostorybooks.com"
                      className="underline decoration-red-400 underline-offset-2 hover:text-red-900"
                    >
                      support@herostorybooks.com
                    </a>{" "}
                    and we&apos;ll help you finish the order manually.
                  </p>
                </div>
              )}
              <button
                type="submit"
                disabled={isSubmitting || !isReadyToPay || currentStepId !== "review"}
                className="w-full rounded-2xl bg-deep-gold py-4 text-lg font-bold text-navy shadow-md transition-all hover:-translate-y-0.5 hover:bg-deep-gold/90 hover:shadow-lg disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
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
