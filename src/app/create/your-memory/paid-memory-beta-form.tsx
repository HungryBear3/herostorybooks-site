"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";

type BookFormat = "digital" | "classic" | "premium";

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string; code?: string }
  | { kind: "ready"; redirectTo: string };

const FORMATS: Array<{ id: BookFormat; label: string; price: string; helper: string }> = [
  { id: "digital", label: "Digital proof", price: "$19", helper: "Best first beta lane; no print/shipping step." },
  { id: "classic", label: "Softcover", price: "$39", helper: "Includes digital proof; print remains approval-gated." },
  { id: "premium", label: "Hardcover", price: "$64", helper: "Includes digital proof; print remains approval-gated." },
];

const pronouns = ["they/them", "he/him", "she/her"] as const;

function splitLines(value: string): string[] {
  return value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function firstNonEmpty(...values: string[]): string {
  return values.map((value) => value.trim()).find(Boolean) ?? "Family Hero";
}

function buildAnchors(mustInclude: string) {
  const anchors = splitLines(mustInclude).slice(0, 6);
  if (anchors.length > 0) {
    return anchors.map((anchor) => ({ anchor, aliases: [] as string[] }));
  }
  return [{ anchor: "family memory", aliases: ["shared memory"] }];
}

export function PaidMemoryBetaForm({ paidBetaEnabled }: { paidBetaEnabled: boolean }) {
  const [buyerName, setBuyerName] = useState("");
  const [email, setEmail] = useState("");
  const [format, setFormat] = useState<BookFormat>("digital");
  const [heroOne, setHeroOne] = useState("");
  const [heroTwo, setHeroTwo] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [recipientRole, setRecipientRole] = useState("audience");
  const [recipientPronouns, setRecipientPronouns] = useState<(typeof pronouns)[number]>("they/them");
  const [setting, setSetting] = useState("");
  const [coreMemory, setCoreMemory] = useState("");
  const [mustInclude, setMustInclude] = useState("");
  const [mustAvoid, setMustAvoid] = useState("");
  const [tone, setTone] = useState("warm, playful, heartfelt");
  const [lesson, setLesson] = useState("Family stories can make ordinary moments feel brave, funny, and worth remembering.");
  const [skinTone, setSkinTone] = useState("reference photos / manual review");
  const [hairStyle, setHairStyle] = useState("reference photos / manual review");
  const [consent, setConsent] = useState(false);
  const [ack, setAck] = useState(false);
  const [state, setState] = useState<SubmitState>({ kind: "idle" });

  const heroes = useMemo(() => [heroOne, heroTwo].map((name) => name.trim()).filter(Boolean).slice(0, 2), [heroOne, heroTwo]);
  const routeDisabledReason = !paidBetaEnabled
    ? "Paid beta gate is not enabled yet."
    : !email.trim() || !recipientName.trim() || heroes.length === 0 || !setting.trim() || !coreMemory.trim() || !consent || !ack
      ? "Complete the required fields and beta acknowledgements."
      : null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (routeDisabledReason) {
      setState({ kind: "error", message: routeDisabledReason });
      return;
    }
    setState({ kind: "submitting" });

    const primaryHeroes = heroes.map((name, index) => ({
      name,
      role: index === 0 ? "primary_hero" : "co_protagonist",
      ageStage: "adult/family member — private beta manual review",
      traits: [],
    }));
    const castLock = Array.from(new Set([...heroes, recipientName.trim()].filter(Boolean)));
    const brief = {
      workingTitle: `${firstNonEmpty(recipientName, heroOne)}'s Custom Family Book`,
      storyShape: {
        heroStructure: heroes.length > 1 ? "dual-parent" : "parent",
        storySource: "memory",
        childRole: recipientRole === "recipient" ? "recipient" : "audience",
      },
      primaryHeroes,
      recipientAudience: {
        name: recipientName.trim(),
        role: recipientRole === "recipient" ? "recipient" : "audience",
        ageStage: "child/family recipient — does not drive the plot unless separately approved",
        rules: ["Recipient may observe, react, receive the gift, or frame the story; do not make recipient the plot rescuer."],
      },
      setting: setting.trim(),
      coreMemory: coreMemory.trim(),
      mustInclude: buildAnchors(mustInclude),
      mustAvoid: splitLines(mustAvoid),
      tone: splitLines(tone.replace(/,/g, "\n")),
      lesson: lesson.trim(),
      sanitizedSourceSummary: coreMemory.trim(),
      castLock,
      provenance: {
        source: "written-note",
        voiceMemoDerived: false,
        transcriptSanitized: true,
        briefApprovedByOperator: false,
        sourceTranscriptAvailableToProofLane: false,
      },
    };

    const form = new FormData();
    form.set("childName", recipientName.trim());
    form.set("heroName", heroes[0]);
    form.set("heroType", "child");
    form.set("heroAgeOrStage", "private beta manual review");
    form.set("recipientName", recipientName.trim());
    form.set("recipientRelationship", heroes.length > 1 ? `${heroes.join(" + ")} to ${recipientName.trim()}` : `${heroes[0]} to ${recipientName.trim()}`);
    form.set("storyPerspective", "custom-memory-concierge");
    form.set("email", email.trim());
    form.set("bookFormat", format);
    form.set("theme", "custom-voice-story");
    form.set("childPronouns", recipientPronouns);
    form.set("skinTone", skinTone.trim() || "manual review");
    form.set("hairStyle", hairStyle.trim() || "manual review");
    form.set("appearanceOptions", JSON.stringify({ skinTone: skinTone.trim(), hairStyle: hairStyle.trim(), source: "custom-memory-paid-beta" }));
    form.set("occasion", "friends-family-paid-beta");
    form.set("lesson", lesson.trim());
    form.set("giftMessage", `Buyer/contact: ${buyerName.trim() || "not supplied"}. Beta custom-memory request; human review required before proof/print.`);
    form.set("characterNotes", `Custom-memory paid beta. Consent acknowledged: ${consent ? "yes" : "no"}. Manual proof/print gate acknowledged: ${ack ? "yes" : "no"}.`);
    form.set("customStoryBrief", JSON.stringify(brief));

    const response = await fetch("/api/order", { method: "POST", body: form });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.redirectTo) {
      setState({ kind: "error", message: data.error || "Could not start checkout. No charge was made.", code: data.code });
      return;
    }
    setState({ kind: "ready", redirectTo: data.redirectTo });
    window.location.href = data.redirectTo;
  }

  return (
    <main className="min-h-screen bg-cream px-4 py-10 text-forest">
      <div className="mx-auto max-w-5xl space-y-8">
        <header className="rounded-[2rem] bg-white p-7 shadow-sm border border-forest/10">
          <Link href="/" className="text-xs font-semibold uppercase tracking-[0.2em] text-forest/60">← Hero Story Books</Link>
          <div className="mt-5 grid gap-6 md:grid-cols-[1.3fr_0.7fr] md:items-end">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.25em] text-coral">Private friends & family beta</p>
              <h1 className="mt-3 font-serif text-4xl font-bold leading-tight md:text-5xl">Request a custom family memory book</h1>
              <p className="mt-4 max-w-2xl text-base text-gray-700">
                This website lane takes a real payment receipt so we can harden orders end-to-end. It does <strong>not</strong> automatically generate, release, print, or publicly reuse your book.
              </p>
            </div>
            <div className="rounded-2xl bg-forest p-5 text-sm text-white">
              <p className="font-semibold">What happens after checkout</p>
              <ol className="mt-3 list-decimal space-y-2 pl-5 text-white/85">
                <li>Order is saved before Stripe.</li>
                <li>Payment receipt is issued.</li>
                <li>Human review turns your notes into a production brief.</li>
                <li>You approve a proof before print.</li>
              </ol>
            </div>
          </div>
        </header>

        {!paidBetaEnabled && (
          <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
            Paid beta checkout is not enabled on this deployment yet. The form is visible for QA, but submit is blocked until <code>HSB_CUSTOM_STORY_PAID_BETA=true</code> is enabled.
          </div>
        )}

        <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <section className="space-y-5 rounded-[2rem] border border-forest/10 bg-white p-6 shadow-sm">
            <Field label="Buyer/contact name" value={buyerName} onChange={setBuyerName} placeholder="Your name" />
            <Field label="Email for receipt + follow-up" type="email" value={email} onChange={setEmail} placeholder="you@example.com" required />
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Primary hero / parent / family member" value={heroOne} onChange={setHeroOne} placeholder="Dad, Mom, Grandpa, etc." required />
              <Field label="Optional co-hero" value={heroTwo} onChange={setHeroTwo} placeholder="Mom, Dad, Grandma, etc." />
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Book recipient / audience" value={recipientName} onChange={setRecipientName} placeholder="Lukas" required />
              <label className="block text-sm font-semibold text-forest">
                Recipient role
                <select value={recipientRole} onChange={(event) => setRecipientRole(event.target.value)} className="mt-2 w-full rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm">
                  <option value="audience">Audience / listener</option>
                  <option value="recipient">Gift recipient</option>
                </select>
              </label>
              <label className="block text-sm font-semibold text-forest">
                Recipient pronouns
                <select value={recipientPronouns} onChange={(event) => setRecipientPronouns(event.target.value as (typeof pronouns)[number])} className="mt-2 w-full rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm">
                  {pronouns.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
            </div>
            <Field label="Main setting" value={setting} onChange={setSetting} placeholder="The lake, a kitchen, a family trip, a backyard adventure..." required />
            <TextArea label="Sanitized memory summary" value={coreMemory} onChange={setCoreMemory} placeholder="Tell us the memory in your own words. Do not paste raw transcripts; summarize what matters." required />
            <TextArea label="Must include — one beat per line" value={mustInclude} onChange={setMustInclude} placeholder="Dad's birthday boat ride\nThe taco bar\nMom protects the fun" />
            <TextArea label="Must avoid — one line each" value={mustAvoid} onChange={setMustAvoid} placeholder="No divorce language\nNo real business names\nNo public sample use" />
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Tone" value={tone} onChange={setTone} placeholder="warm, playful, heartfelt" />
              <Field label="Lesson / feeling" value={lesson} onChange={setLesson} placeholder="What should the book leave them feeling?" />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Appearance / skin tone note" value={skinTone} onChange={setSkinTone} placeholder="Manual review / from references" />
              <Field label="Hair / visual note" value={hairStyle} onChange={setHairStyle} placeholder="Manual review / from references" />
            </div>
          </section>

          <aside className="space-y-5">
            <section className="rounded-[2rem] border border-forest/10 bg-white p-5 shadow-sm">
              <p className="text-sm font-bold uppercase tracking-[0.18em] text-forest/60">Choose receipt</p>
              <div className="mt-4 space-y-3">
                {FORMATS.map((item) => (
                  <label key={item.id} className={`block cursor-pointer rounded-2xl border p-4 ${format === item.id ? "border-forest bg-forest/5" : "border-gray-200"}`}>
                    <input type="radio" name="bookFormat" value={item.id} checked={format === item.id} onChange={() => setFormat(item.id)} className="sr-only" />
                    <span className="flex items-center justify-between gap-3 font-semibold"><span>{item.label}</span><span>{item.price}</span></span>
                    <span className="mt-1 block text-xs text-gray-600">{item.helper}</span>
                  </label>
                ))}
              </div>
            </section>

            <section className="rounded-[2rem] border border-forest/10 bg-white p-5 text-sm shadow-sm">
              <p className="font-bold text-forest">Required beta acknowledgements</p>
              <label className="mt-4 flex gap-3 text-gray-700">
                <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="mt-1" />
                <span>I have permission to submit this private family-memory request and understand references are for private production review only.</span>
              </label>
              <label className="mt-4 flex gap-3 text-gray-700">
                <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} className="mt-1" />
                <span>I understand payment starts concierge review only. No automatic proof, print, likeness rendering, shipping, or public sample use.</span>
              </label>
            </section>

            {state.kind === "error" && (
              <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                <p className="font-semibold">Checkout blocked — no charge made</p>
                <p className="mt-1">{state.message}</p>
                {state.code && <p className="mt-1 font-mono text-xs">{state.code}</p>}
              </div>
            )}
            {state.kind === "ready" && (
              <div className="rounded-2xl border border-forest/20 bg-forest/5 p-4 text-sm text-forest">
                Stripe checkout is ready. If you are not redirected, <a className="underline" href={state.redirectTo}>continue here</a>.
              </div>
            )}

            <button
              type="submit"
              disabled={Boolean(routeDisabledReason) || state.kind === "submitting"}
              className="w-full rounded-full bg-coral px-5 py-4 text-base font-bold text-white shadow-sm disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {state.kind === "submitting" ? "Starting checkout…" : `Start paid beta checkout (${FORMATS.find((f) => f.id === format)?.price})`}
            </button>
            {routeDisabledReason && <p className="text-center text-xs text-gray-500">{routeDisabledReason}</p>}
          </aside>
        </form>
      </div>
    </main>
  );
}

function Field({ label, value, onChange, placeholder, required, type = "text" }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; required?: boolean; type?: string }) {
  return (
    <label className="block text-sm font-semibold text-forest">
      {label}{required ? <span className="text-coral"> *</span> : null}
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        className="mt-2 w-full rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm outline-none focus:border-forest"
      />
    </label>
  );
}

function TextArea({ label, value, onChange, placeholder, required }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; required?: boolean }) {
  return (
    <label className="block text-sm font-semibold text-forest">
      {label}{required ? <span className="text-coral"> *</span> : null}
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        rows={4}
        className="mt-2 w-full rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm outline-none focus:border-forest"
      />
    </label>
  );
}
