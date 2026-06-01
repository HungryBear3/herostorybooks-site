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
          <Row label="Child name" value={order.childName} />
          <Row label="Email" value={order.email} />
          <Row label="Format" value={order.formatLabel} />
          <Row label="Price" value={`$${(order.priceCents / 100).toFixed(2)}`} />
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
          <Row label="Custom story selected" value={diagnostics.storyInput.theme === 'custom-voice-story' ? 'yes' : 'no'} />
          <Row label="Custom text present" value={diagnostics.storyInput.hasCustomText ? 'yes' : 'no'} />
          <Row label="Story direction" value={diagnostics.storyInput.theme ?? '—'} />
          <Row label="Custom story lesson" value={diagnostics.storyInput.lesson ?? '—'} />
          <Row label="Occasion" value={diagnostics.storyInput.occasion ?? '—'} />
          <Row label="Gift message" value={diagnostics.storyInput.giftMessagePreview ?? '—'} />
          <Row label="Character notes" value={diagnostics.storyInput.characterNotesPreview ?? '—'} />
          <Row label="Inspiration upload present" value={diagnostics.storyInput.hasVoiceOrUpload ? 'yes' : 'no'} />
          {diagnostics.storyInput.hasVoiceOrUpload && (
            <>
              <Row label="Upload source" value={diagnostics.storyInput.voiceSource ?? 'uploaded/unknown'} />
              <Row label="Upload file" value={diagnostics.storyInput.voiceFileName ?? '—'} />
              <Row label="Upload blob path" value={diagnostics.storyInput.voiceBlobPath ?? '—'} mono />
              <Row label="Consent recorded" value={diagnostics.storyInput.voiceConsentAt ?? '—'} />
              <Row label="Transcript status" value={diagnostics.storyInput.transcriptStatus} tone={diagnostics.storyInput.transcriptStatus === 'failed' ? 'bad' : 'neutral'} />
              <Row label="Transcript model" value={diagnostics.storyInput.transcriptModel ?? '—'} mono />
              <Row label="Story inspiration" value={diagnostics.storyInput.inspirationPreview ?? '—'} />
              <Row
                label="Transcript preview"
                value={
                  diagnostics.storyInput.transcriptPreview
                    ? `${diagnostics.storyInput.transcriptPreview}${diagnostics.storyInput.transcriptChars != null ? ` (${diagnostics.storyInput.transcriptChars} chars)` : ''}`
                    : '—'
                }
              />
              {diagnostics.storyInput.transcriptError && (
                <Row label="Transcript error" value={diagnostics.storyInput.transcriptError} tone="bad" />
              )}
            </>
          )}
        </Section>

        <Section title="Art direction">
          <Row
            label="Packet"
            value={
              diagnostics.artDirection.status === 'absent'
                ? 'not yet generated'
                : diagnostics.artDirection.status
            }
            tone={diagnostics.artDirection.status === 'invalid' ? 'bad' : diagnostics.artDirection.status === 'present' ? 'good' : 'neutral'}
          />
          <Row
            label="Storyboard"
            value={diagnostics.artDirection.storyboard.validationStatus}
            tone={diagnostics.artDirection.storyboard.validationStatus === 'complete' ? 'good' : diagnostics.artDirection.storyboard.validationStatus === 'incomplete' ? 'bad' : 'neutral'}
          />
          <Row label="Generated" value={diagnostics.artDirection.generatedAt ?? '—'} />
          <Row label="Human review" value={diagnostics.artDirection.humanReviewStatus ?? '—'} />
          {diagnostics.artDirection.humanReviewNotes && (
            <Row label="Review notes" value={diagnostics.artDirection.humanReviewNotes} />
          )}

          {diagnostics.artDirection.styleBible ? (
            <>
              <Row label="Style" value={`${diagnostics.artDirection.styleBible.targetIllustrationStyle ?? '—'} · ${diagnostics.artDirection.styleBible.renderingLevel ?? '—'}`} />
              <Row label="Style template" value={diagnostics.artDirection.styleBible.templateId ?? '—'} mono />
              <Row label="Style approved" value={`${diagnostics.artDirection.styleBible.approvedBy ?? '—'} · ${diagnostics.artDirection.styleBible.approvedAt ?? '—'}`} />
              <Row label="Palette / prohibited" value={`${diagnostics.artDirection.styleBible.paletteColorCount} colors · ${diagnostics.artDirection.styleBible.prohibitedCount} prohibited terms`} />
              <Row label="Continuity motifs" value={
                diagnostics.artDirection.styleBible.continuityMotifs.length > 0
                  ? diagnostics.artDirection.styleBible.continuityMotifs.join(', ')
                  : '—'
              } />
            </>
          ) : (
            <Row label="Style bible" value="not available" />
          )}

          <Row
            label="Character sheets"
            value={`${diagnostics.artDirection.characterSheets.approvedCount}/${diagnostics.artDirection.characterSheets.count} approved · roles: ${diagnostics.artDirection.characterSheets.roles.join(', ') || '—'}`}
          />
          {diagnostics.artDirection.characterSheets.summaries.length > 0 && (
            <div className="mt-3 rounded-lg border border-gray-100 overflow-hidden">
              {diagnostics.artDirection.characterSheets.summaries.map((sheet, index) => (
                <div key={`${sheet.id ?? index}`} className="grid grid-cols-2 gap-2 border-t first:border-t-0 border-gray-100 px-3 py-2 text-xs">
                  <span className="text-gray-500">{sheet.name ?? sheet.id ?? 'Character'}</span>
                  <span className="text-right text-gray-700">
                    {sheet.role ?? '—'} · {sheet.approvedBy ? 'approved' : 'not approved'} · traits {sheet.recurringTraitCount}
                  </span>
                </div>
              ))}
            </div>
          )}

          <Row label="Storyboard entries" value={`${diagnostics.artDirection.storyboard.actualEntries ?? 0} / ${diagnostics.artDirection.storyboard.expectedEntries ?? 24}`} />
          <Row label="Storyboard issues" value={`${diagnostics.artDirection.storyboard.errorCount} errors · ${diagnostics.artDirection.storyboard.warningCount} warnings`} tone={diagnostics.artDirection.storyboard.errorCount > 0 ? 'bad' : 'neutral'} />
          <Row label="Continuity counts" value={`${diagnostics.artDirection.continuity.pagesWithContinuityCallback} callbacks · ${diagnostics.artDirection.continuity.uniqueRecurringObjectCount} unique recurring objects`} />
          {(diagnostics.artDirection.schemaErrors.length > 0 ||
            diagnostics.artDirection.storyboard.errors.length > 0 ||
            diagnostics.artDirection.storyboard.warnings.length > 0) && (
            <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50/60 p-3">
              <p className="text-[10px] uppercase tracking-wider text-amber-900 mb-2">Validation issues</p>
              <ul className="space-y-1 text-xs text-amber-950">
                {[
                  ...diagnostics.artDirection.schemaErrors,
                  ...diagnostics.artDirection.storyboard.errors,
                  ...diagnostics.artDirection.storyboard.warnings,
                ].slice(0, 8).map((issue, index) => (
                  <li key={`${issue.code}-${issue.path}-${index}`}>
                    <span className="font-mono text-[10px]">{issue.code}</span>
                    {' · '}
                    <span className="font-mono text-[10px]">{issue.path}</span>
                    {issue.pageNumber != null && <span> · page {issue.pageNumber}</span>}
                    {' — '}
                    <span>{issue.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>

        <Section title="Payment">
          <Row label="Status" value={order.paymentStatus} tone={order.paymentStatus === 'paid' ? 'good' : 'neutral'} />
          <Row label="Stripe session" value={order.stripeSessionId ?? '—'} mono />
        </Section>

        <Section title="Fulfillment">
          <Row label="Fulfillment status" value={order.fulfillmentStatus ?? 'not_started'}
               tone={order.fulfillmentStatus === 'failed_manual_review' ? 'bad' : order.fulfillmentStatus === 'complete' ? 'good' : 'neutral'} />
          <Row label="Order status" value={order.status} />
          <Row label="QA pass at" value={order.qaPassAt ?? '—'} />
          <Row label="QA pass by" value={order.qaPassBy ?? '—'} />
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
          hasArtifact={Boolean(order.storyArtifactUrl)}
          isFailed={order.fulfillmentStatus === 'failed_manual_review'}
          paymentPaid={order.paymentStatus === 'paid'}
          qaPassAt={order.qaPassAt ?? ''}
          qaPassBy={order.qaPassBy ?? ''}
          proofApprovedAt={order.proofApprovedAt ?? ''}
          printApprovedAt={order.printApprovedAt ?? ''}
          ownerPrintGoAt={order.ownerPrintGoAt ?? ''}
          ownerPrintGoBy={order.ownerPrintGoBy ?? ''}
          printJobId={order.printJobId ?? ''}
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
