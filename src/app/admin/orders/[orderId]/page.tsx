import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getConfiguredAdminKey } from '@/lib/admin-auth';
import { isAdminAuthedFromCookie } from '@/lib/admin-auth-server';
import { getOrder } from '@/lib/orders';
import { buildOrderDiagnostics, formatDiagnosticsSummary } from '@/lib/order-diagnostics';

import OrderDetailActions from './detail-client';
import PageReviewGrid from './page-review-grid';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ orderId: string }> };

export default async function AdminOrderDetail({ params }: Props) {
  if (!getConfiguredAdminKey()) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center px-4">
        <div className="bg-white border rounded-2xl p-8 max-w-md text-center">
          <h1 className="font-serif text-2xl font-bold text-forest">Ops dashboard disabled</h1>
        </div>
      </div>
    );
  }
  const authed = await isAdminAuthedFromCookie();
  if (!authed) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center px-4">
        <div className="bg-white border rounded-2xl p-8 max-w-md text-center">
          <p className="text-sm text-gray-600 mb-4">Sign in first.</p>
          <Link href="/admin/orders" className="underline text-forest">Go to sign-in</Link>
        </div>
      </div>
    );
  }

  const { orderId } = await params;
  const order = await getOrder(orderId);
  if (!order) notFound();

  const isPrint = order.bookFormat === 'classic' || order.bookFormat === 'premium';
  const diagnostics = buildOrderDiagnostics(order);
  const supportSummary = formatDiagnosticsSummary(diagnostics);
  const familyCharacters = Array.isArray(order.familyCharacters) ? order.familyCharacters : [];
  const previewText = (value: string | null | undefined, max = 240) => {
    const text = (value ?? '').trim();
    if (!text) return null;
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };
  const storyInput = {
    theme: order.theme ?? null,
    hasCustomText: Boolean((order.lesson ?? '').trim() || (order.giftMessage ?? '').trim() || (order.characterNotes ?? '').trim()),
    lesson: order.lesson ?? null,
    occasion: order.occasion ?? null,
    giftMessagePreview: previewText(order.giftMessage),
    characterNotesPreview: previewText(order.characterNotes),
    hasVoiceOrUpload: Boolean(order.voiceFileName || order.voiceBlobPath || order.voiceConsentAt || order.voiceTranscript),
    voiceSource: order.voiceSource ?? null,
    voiceFileName: order.voiceFileName ?? null,
    voiceBlobPath: order.voiceBlobPath ?? null,
    voiceConsentAt: order.voiceConsentAt ?? null,
    transcriptStatus: order.voiceTranscript?.status ?? 'not_enabled',
    transcriptModel: order.voiceTranscript?.model ?? null,
    inspirationPreview: previewText(order.voiceTranscript?.inspiration, 400),
    transcriptPreview: previewText(order.voiceTranscript?.text, 400),
    transcriptChars: order.voiceTranscript?.text?.length ?? null,
    transcriptError: order.voiceTranscript?.error ?? null,
    customBriefTitle: order.customStoryBrief?.workingTitle ?? null,
    customBriefShape: order.customStoryBrief
      ? `${order.customStoryBrief.storyShape.heroStructure} / ${order.customStoryBrief.storyShape.storySource} / ${order.customStoryBrief.storyShape.childRole}`
      : null,
    customBriefApproved: order.customStoryBrief?.provenance?.briefApprovedByOperator ?? null,
    customBriefSanitized: order.customStoryBrief?.provenance?.transcriptSanitized ?? null,
    customBriefSummary: previewText(order.customStoryBrief?.sanitizedSourceSummary, 400),
    customBriefValidationRoute: order.customStoryValidation?.route ?? null,
    customBriefValidationFailures: order.customStoryValidation?.failures ?? [],
  };

  return (
    <div className="min-h-screen bg-cream px-4 py-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <header className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <Link href="/admin/orders" className="text-xs text-gray-500 underline">← All orders</Link>
            <h1 className="font-serif text-2xl font-bold text-forest mt-1">{order.childName}</h1>
            <p className="text-xs text-gray-500 font-mono">{order.id}</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <a href={`/status/${order.id}`} target="_blank" rel="noopener"
               className="text-xs underline text-forest self-center">Customer view ↗</a>
            <a href={`/api/admin/orders/${order.id}/diagnostics`} target="_blank" rel="noopener"
               className="text-xs underline text-forest self-center">Diagnostics JSON ↗</a>
          </div>
        </header>

        <section className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
            <h2 className="text-xs uppercase tracking-wider text-gray-500">Diagnostics</h2>
            <span className="text-[10px] text-gray-400">
              {diagnostics.checks.filter((c) => c.severity === 'fail').length} fail ·{' '}
              {diagnostics.checks.filter((c) => c.severity === 'warn').length} warn ·{' '}
              {diagnostics.checks.filter((c) => c.severity === 'ok').length} ok
            </span>
          </div>
          <ul className="space-y-1.5 text-xs">
            {diagnostics.checks.map((c) => (
              <li key={c.id} className={`flex items-start gap-2 rounded px-2 py-1.5 ${
                c.severity === 'fail' ? 'bg-coral/10 text-coral-dark' :
                c.severity === 'warn' ? 'bg-amber-50 text-amber-900' :
                c.severity === 'ok' ? 'bg-forest/5 text-forest' : 'bg-gray-50 text-gray-700'
              }`}>
                <span className="font-mono text-[10px] uppercase mt-0.5 shrink-0">[{c.severity}]</span>
                <span className="flex-1"><span className="font-semibold">{c.label}</span> — <span className="opacity-80">{c.detail}</span></span>
              </li>
            ))}
          </ul>
          <details className="mt-3">
            <summary className="text-[11px] uppercase tracking-wider text-gray-500 cursor-pointer">Copy diagnostics for support</summary>
            <pre className="mt-2 bg-gray-50 border border-gray-100 rounded p-2 text-[11px] font-mono whitespace-pre-wrap break-all">{supportSummary}</pre>
          </details>
        </section>

        <Section title="Order">
          <Row label="Legacy child name" value={order.childName} />
          <Row label="Hero name" value={order.heroName ?? order.childName} />
          <Row label="Hero type" value={order.heroType ?? 'child'} />
          <Row label="Hero age / stage" value={order.heroAgeOrStage ?? order.childAge ?? '—'} />
          <Row label="Book recipient" value={order.recipientName ?? '—'} />
          <Row label="Hero relationship to recipient" value={order.recipientRelationship ?? '—'} />
          <Row label="Main photo focus" value={order.heroPhotoFocusLabel ?? '—'} />
          <Row label="Main photo crop hint" value={order.heroPhotoCropHint ?? '—'} />
          <Row label="Email" value={order.email} />
          <Row label="Format" value={order.formatLabel} />
          <Row label="Price" value={`$${(order.priceCents / 100).toFixed(2)}`} />
          <Row label="Checkout cohort" value={order.checkoutTracking?.cohort ?? '—'} mono={Boolean(order.checkoutTracking?.cohort)} />
          <Row label="Checkout invite" value={order.checkoutTracking?.invite ?? '—'} mono={Boolean(order.checkoutTracking?.invite)} />
          {order.internalDisposition && (
            <>
              <Row label="Internal disposition" value={order.internalDisposition} tone="neutral" />
              <Row label="Disposition note" value={order.internalDispositionNote ?? '—'} />
              <Row label="Disposition marked" value={order.internalDispositionAt ?? '—'} />
            </>
          )}
          <Row label="Created" value={order.createdAt} />
          <Row label="Updated" value={order.updatedAt} />
        </Section>

        <Section title="Story source + input">
          <Row label="Story source" value={diagnostics.story.source ?? 'unknown'} tone={diagnostics.story.source === 'template_after_openai_failure' ? 'bad' : 'neutral'} />
          <Row label="Story model" value={diagnostics.story.model ?? '—'} mono />
          <Row label="Story generated" value={diagnostics.story.generatedAt ?? '—'} />
          {diagnostics.story.fallbackError && (
            <Row label="Fallback reason" value={diagnostics.story.fallbackError} tone="bad" />
          )}
          <Row label="Custom story selected" value={storyInput.theme === 'custom-voice-story' ? 'yes' : 'no'} />
          <Row label="Custom text present" value={storyInput.hasCustomText ? 'yes' : 'no'} />
          <Row label="Story direction" value={storyInput.theme ?? '—'} />
          <Row label="Custom story lesson" value={storyInput.lesson ?? '—'} />
          <Row label="Occasion" value={storyInput.occasion ?? '—'} />
          <Row label="Gift message" value={storyInput.giftMessagePreview ?? '—'} />
          <Row label="Character notes" value={storyInput.characterNotesPreview ?? '—'} />
          <Row label="Inspiration upload present" value={storyInput.hasVoiceOrUpload ? 'yes' : 'no'} />
          {storyInput.hasVoiceOrUpload && (
            <>
              <Row label="Upload source" value={storyInput.voiceSource ?? 'uploaded/unknown'} />
              <Row label="Upload file" value={storyInput.voiceFileName ?? '—'} />
              <Row label="Upload blob path" value={storyInput.voiceBlobPath ?? '—'} mono />
              <Row label="Consent recorded" value={storyInput.voiceConsentAt ?? '—'} />
              <Row label="Transcript status" value={storyInput.transcriptStatus} tone={storyInput.transcriptStatus === 'failed' ? 'bad' : 'neutral'} />
              <Row label="Transcript model" value={storyInput.transcriptModel ?? '—'} mono />
              <Row label="Story inspiration" value={storyInput.inspirationPreview ?? '—'} />
              <Row
                label="Transcript preview"
                value={
                  storyInput.transcriptPreview
                    ? `${storyInput.transcriptPreview}${storyInput.transcriptChars != null ? ` (${storyInput.transcriptChars} chars)` : ''}`
                    : '—'
                }
              />
              {storyInput.transcriptError && (
                <Row label="Transcript error" value={storyInput.transcriptError} tone="bad" />
              )}
            </>
          )}
          {storyInput.customBriefTitle && (
            <>
              <Row label="Custom brief title" value={storyInput.customBriefTitle} />
              <Row label="Custom story shape" value={storyInput.customBriefShape ?? '—'} />
              <Row label="Brief sanitized" value={storyInput.customBriefSanitized ? 'yes' : 'no'} tone={storyInput.customBriefSanitized ? 'good' : 'bad'} />
              <Row label="Operator approved" value={storyInput.customBriefApproved ? 'yes' : 'no'} tone={storyInput.customBriefApproved ? 'good' : 'bad'} />
              <Row label="Validation route" value={storyInput.customBriefValidationRoute ?? 'not_run'} tone={storyInput.customBriefValidationRoute === 'manual_queue' ? 'bad' : 'neutral'} />
              <Row label="Sanitized source summary" value={storyInput.customBriefSummary ?? '—'} />
              {storyInput.customBriefValidationFailures.length > 0 && (
                <Row label="Validation failures" value={storyInput.customBriefValidationFailures.map((failure) => failure.code).join(', ')} tone="bad" />
              )}
            </>
          )}
        </Section>

        {familyCharacters.length > 0 && (
          <Section title="People, pets, and identity inputs">
            {familyCharacters.map((character, index) => (
              <div key={`${character.role}-${character.name}-${index}`} className="mb-3 rounded-lg border border-gray-100 p-3 last:mb-0">
                <Row label={`Character ${index + 1}`} value={character.name || character.relationshipLabel || character.role} />
                <Row label="Role / relationship" value={`${character.role} · ${character.relationshipLabel || '—'}`} />
                <Row label="Story wording" value={character.pronouns || '—'} />
                <Row label="Appears in story" value={character.appearsInStory ? 'yes' : 'no'} />
                <Row label="Gift recipient" value={character.isGiftRecipient ? 'yes' : 'no'} />
                <Row label="Notes" value={character.notes || '—'} />
                <Row label="Reference photo" value={character.photoFileName || character.photoBlobPath || '—'} mono={Boolean(character.photoBlobPath)} />
                <Row label="Photo focus" value={character.focusPersonLabel ?? '—'} />
                <Row label="Photo crop hint" value={character.cropHint ?? '—'} />
              </div>
            ))}
          </Section>
        )}


        <Section title="Payment">
          <Row label="Status" value={order.paymentStatus} tone={order.paymentStatus === 'paid' ? 'good' : 'neutral'} />
          <Row label="Stripe session" value={order.stripeSessionId ?? '—'} mono />
        </Section>

        <Section title="Fulfillment">
          <Row label="Fulfillment status" value={order.fulfillmentStatus ?? 'not_started'}
               tone={order.fulfillmentStatus === 'failed_manual_review' ? 'bad' : order.fulfillmentStatus === 'complete' ? 'good' : 'neutral'} />
          <Row label="Order status" value={order.status} />
          <Row label="Attempts" value={String(order.fulfillmentAttempts ?? 0)} />
          {order.fulfillmentLastError && <Row label="Last error" value={order.fulfillmentLastError} tone="bad" />}
          <Row label="Artifact" value={order.storyArtifactUrl ?? '—'}
               link={order.storyArtifactUrl ?? undefined} mono />
        </Section>

        {isPrint && (
          <Section title="Print + shipping">
            <Row label="Proof token set" value={order.proofApprovalToken ? 'yes' : 'no'} />
            <Row label="Proof approved at" value={order.proofApprovedAt ?? '—'} />
            <Row label="Print job id" value={order.printJobId ?? '—'} mono />
            <Row label="Print job status" value={order.printJobStatus ?? '—'} />
            <Row label="Tracking number" value={order.trackingNumber ?? '—'} mono />
            <Row label="Tracking URL" value={order.trackingUrl ?? '—'} link={order.trackingUrl ?? undefined} mono />
            <Row label="Shipped at" value={order.shippedAt ?? '—'} />
            {order.shippingAddress && (
              <Row label="Ships to" value={
                `${order.shippingAddress.line1}${order.shippingAddress.line2 ? ', ' + order.shippingAddress.line2 : ''}, ${order.shippingAddress.city}, ${order.shippingAddress.state} ${order.shippingAddress.zip}, ${order.shippingAddress.country}`
              } />
            )}
          </Section>
        )}

        {order.pageArtifacts && order.pageArtifacts.length > 0 && (
          <PageReviewGrid orderId={order.id} pages={order.pageArtifacts} />
        )}

        {order.pageArtifacts && order.pageArtifacts.length > 0 && (
          <section className="bg-white border border-gray-200 rounded-xl p-5">
            <h2 className="text-xs uppercase tracking-wider text-gray-500 mb-3">Customer review</h2>
            <dl className="space-y-2 mb-4">
              <Row label="Review status" value={order.reviewStatus ?? 'not_started'}
                   tone={order.reviewStatus === 'approved' ? 'good' : order.reviewStatus === 'customer_changes_requested' ? 'neutral' : 'neutral'} />
              <Row label="Pages" value={String(order.pageArtifacts.length)} />
              <Row label="Pages accepted" value={`${order.pageArtifacts.filter((p) => p.accepted).length} / ${order.pageArtifacts.length}`} />
              <Row label="Total regenerations" value={String(order.pageArtifacts.reduce((sum, p) => sum + p.regenerateCount, 0))} />
            </dl>
            <div className="space-y-3">
              {[...order.pageArtifacts].sort((a, b) => a.pageIndex - b.pageIndex).map((p) => (
                <details key={p.pageIndex} className="rounded-lg border border-gray-100 px-3 py-2 text-xs">
                  <summary className="cursor-pointer font-semibold text-forest flex flex-wrap gap-2 items-center">
                    <span>Page {p.pageIndex + 1}</span>
                    <span className={`inline-block px-2 py-0.5 rounded-full ${p.accepted ? 'bg-forest/10 text-forest' : 'bg-gray-100 text-gray-600'}`}>
                      {p.accepted ? 'accepted' : 'pending'}
                    </span>
                    <span className="text-gray-500">regens: {p.regenerateCount}</span>
                    {p.regenerateCount >= 5 && (
                      <span className="inline-block px-2 py-0.5 rounded-full bg-coral/20 text-coral-dark">manual review</span>
                    )}
                    {p.generationProvider && (
                      <span className="text-gray-500">last: {p.generationProvider}/{p.generationModel ?? '—'}</span>
                    )}
                    {p.customerReviewStatus === 'changes_requested' && (
                      <span className="inline-block px-2 py-0.5 rounded-full bg-amber-100 text-amber-900">customer changes</span>
                    )}
                  </summary>
                  <div className="mt-2 grid gap-3 sm:grid-cols-3">
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-gray-400 mb-1">Current image</p>
                      {p.currentImageUrl ? (<>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={p.currentImageUrl} alt={`Current page ${p.pageIndex + 1}`} className="mb-1 h-28 w-full rounded border border-gray-100 object-cover" />
                        <a href={p.currentImageUrl} target="_blank" rel="noopener" className="text-forest underline break-all">
                          {p.currentImageUrl}
                        </a>
                      </>) : <span className="text-gray-400">—</span>}
                      {p.acceptedImageUrl && p.acceptedImageUrl !== p.currentImageUrl && (
                        <p className="mt-1 text-gray-500">accepted: <a className="underline break-all" href={p.acceptedImageUrl} target="_blank" rel="noopener">{p.acceptedImageUrl}</a></p>
                      )}
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-gray-400 mb-1">Story text</p>
                      <p className="text-gray-700 line-clamp-4">{p.storyText}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-gray-400 mb-1">Requested change</p>
                      {p.customerRequestedChange ? (
                        <div className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-950">
                          <p className="font-semibold">{p.customerRequestedChange.lifecycleStatus.replace(/_/g, ' ')}</p>
                          <p className="mt-1">{p.customerRequestedChange.note}</p>
                          <p className="mt-1 text-[10px] text-amber-800">{new Date(p.customerRequestedChange.requestedAt).toLocaleString()}</p>
                        </div>
                      ) : <span className="text-gray-400">—</span>}
                    </div>
                  </div>
                  {p.feedbackHistory.length > 0 && (
                    <div className="mt-3">
                      <p className="text-[10px] uppercase tracking-wider text-gray-400 mb-1">Feedback history</p>
                      <ul className="space-y-1">
                        {p.feedbackHistory.map((f, i) => (
                          <li key={i} className="text-gray-700">
                            <span className="text-gray-400">{new Date(f.createdAt).toLocaleString()} · {f.providerTried ?? '—'} · {f.success ? 'ok' : 'failed'}:</span>{' '}
                            {f.rawText || '(no text)'} {f.tags.length > 0 && <span className="text-gray-500">[{f.tags.join(', ')}]</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {p.versionHistory.length > 0 && (
                    <div className="mt-3">
                      <p className="text-[10px] uppercase tracking-wider text-gray-400 mb-1">Version history ({p.versionHistory.length})</p>
                      <div className="mb-2 grid gap-2 sm:grid-cols-2">
                        {p.versionHistory.slice(-2).map((v, i, versions) => (
                          <div key={`${v.createdAt}-${i}`} className="rounded border border-gray-100 bg-gray-50 p-2">
                            <p className="mb-1 text-[10px] uppercase tracking-wider text-gray-400">
                              {versions.length === 1 || i === versions.length - 1 ? 'Current render' : 'Prior render'}
                            </p>
                            {v.imageUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={v.imageUrl} alt={`Render ${i + 1} for page ${p.pageIndex + 1}`} className="h-32 w-full rounded object-cover" />
                            ) : (
                              <div className="flex h-32 items-center justify-center rounded bg-white text-gray-400">no image</div>
                            )}
                            {v.referencePhotoUrl && (
                              <a href={v.referencePhotoUrl} target="_blank" rel="noopener" className="mt-1 block truncate text-forest underline">
                                reference/photo/context
                              </a>
                            )}
                          </div>
                        ))}
                      </div>
                      <ul className="space-y-1 font-mono text-[10px] text-gray-600">
                        {p.versionHistory.map((v, i) => (
                          <li key={i} className="break-all">
                            {new Date(v.createdAt).toLocaleString()} · {v.provider}/{v.model} · {v.imageUrl ?? '(no image)'}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </details>
              ))}
            </div>
          </section>
        )}

        {order.auditEvents && order.auditEvents.length > 0 && (
          <section className="bg-white border border-gray-200 rounded-xl p-5">
            <h2 className="text-xs uppercase tracking-wider text-gray-500 mb-3">Review audit trail</h2>
            <p className="text-xs text-gray-500 mb-3">{order.auditEvents.length} event(s), newest last.</p>
            <ol className="space-y-1.5 text-xs">
              {order.auditEvents.map((e, i) => (
                <li key={i} className="font-mono text-[11px] leading-snug text-gray-700">
                  <span className="text-gray-400">{new Date(e.at).toISOString()}</span>
                  {' · '}
                  <span className={`font-semibold ${
                    e.type === 'whole_book_approval_rejected' ? 'text-coral-dark'
                    : e.type === 'whole_book_approved' ? 'text-forest'
                    : 'text-gray-800'
                  }`}>{e.type}</span>
                  {e.pageIndex != null && <span> · page {e.pageIndex + 1}</span>}
                  {e.reason && <span className="text-coral-dark"> · {e.reason}</span>}
                  {e.meta && Object.keys(e.meta).length > 0 && (
                    <span className="text-gray-500"> · {Object.entries(e.meta)
                      .filter(([, v]) => v !== '' && v !== null && v !== undefined)
                      .map(([k, v]) => `${k}=${String(v)}`).join(', ')}</span>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}

        <OrderDetailActions
          orderId={order.id}
          isPrint={isPrint}
          fulfillmentStatus={order.fulfillmentStatus ?? 'not_started'}
          alreadyShipped={order.status === 'shipped'}
          hasProof={Boolean(order.storyArtifactUrl && order.proofApprovalToken)}
          isFailed={order.fulfillmentStatus === 'failed_manual_review'}
          paymentPaid={order.paymentStatus === 'paid'}
          currentTrackingNumber={order.trackingNumber ?? ''}
          currentTrackingUrl={order.trackingUrl ?? ''}
        />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white border border-gray-200 rounded-xl p-5">
      <h2 className="text-xs uppercase tracking-wider text-gray-500 mb-3">{title}</h2>
      <dl className="space-y-2">{children}</dl>
    </section>
  );
}

function Row({ label, value, tone = 'neutral', link, mono }: {
  label: string; value: string; tone?: 'good' | 'bad' | 'neutral'; link?: string; mono?: boolean;
}) {
  const color = tone === 'good' ? 'text-forest' : tone === 'bad' ? 'text-coral-dark' : 'text-gray-700';
  return (
    <div className="flex flex-wrap justify-between gap-2 text-sm">
      <dt className="text-gray-500">{label}</dt>
      <dd className={`${color} ${mono ? 'font-mono text-xs break-all max-w-[60%]' : 'max-w-[60%] text-right'}`}>
        {link ? <a className="underline" href={link} target="_blank" rel="noopener">{value}</a> : value}
      </dd>
    </div>
  );
}
