/** Browser-only shipping state. Closed analytics callback; no private fields leave this module. */
import { shippingMetricParams, SHIPPING_PRICING_RULES, type ShippingBrowserEvent, type ShippingMetricParams } from './analytics-event-contract.ts';
import type { CheckoutIntakeSession } from './checkout-intake-client-flow.ts';
export type ShippingContact = { name: string; phone: string; line1: string; line2: string; city: string; state: string; postalCode: string; country: 'US' };
export interface ShippingReceipt {
  pricingRuleVersion?: 'landed-delta-v1' | null;
  bookFormat: 'classic' | 'premium'; revision: number; bookCents: number; deltaCents: number;
  deltaTaxIncludedCents: number; totalCents: number; selectedQuoteId: string | null; estimate: string;
  quote: { quoteId: string; service: string; label: string; deltaCents: number; expiresAtMs: number; transitDays: number | null } | null;
}
export const shippingMoney = (cents: number) => `$${(cents / 100).toFixed(2)}`;
export function parseShippingReceipt(value: unknown): ShippingReceipt {
  const r = value as ShippingReceipt;
  if (!r || !['classic', 'premium'].includes(r.bookFormat) || typeof r.estimate !== 'string' ||
    !['revision','bookCents','deltaCents','deltaTaxIncludedCents','totalCents'].every(k => Number.isSafeInteger(r[k as keyof ShippingReceipt]) && Number(r[k as keyof ShippingReceipt]) >= 0) ||
    r.totalCents !== r.bookCents + r.deltaCents || r.deltaTaxIncludedCents > r.deltaCents ||
    (r.selectedQuoteId !== null && typeof r.selectedQuoteId !== 'string') ||
    (r.quote !== null && (!r.quote || typeof r.quote.quoteId !== 'string' || !Number.isSafeInteger(r.quote.expiresAtMs) || r.quote.deltaCents !== r.deltaCents)) ||
    (r.selectedQuoteId !== null && r.selectedQuoteId !== r.quote?.quoteId)) throw new Error('Shipping response unavailable');
  // Do not retain owner-contact echoes or any unexpected response fields.
  return { pricingRuleVersion: SHIPPING_PRICING_RULES.includes(r.pricingRuleVersion as 'landed-delta-v1') ? r.pricingRuleVersion : null, bookFormat: r.bookFormat, revision: r.revision, bookCents: r.bookCents, deltaCents: r.deltaCents,
    deltaTaxIncludedCents: r.deltaTaxIncludedCents, totalCents: r.totalCents, selectedQuoteId: r.selectedQuoteId, estimate: r.estimate,
    quote: r.quote ? { quoteId: r.quote.quoteId, service: r.quote.service, label: r.quote.label,
      deltaCents: r.quote.deltaCents, expiresAtMs: r.quote.expiresAtMs, transitDays: r.quote.transitDays } : null };
}
export interface ShippingView { mode: 'standard' | 'expedited'; status: 'idle' | 'loading' | 'quoted' | 'selected' | 'error'; receipt: ShippingReceipt | null; message: string }
export class InitialShippingClient {
  view: ShippingView = { mode: 'standard', status: 'idle', receipt: null, message: '' };
  epoch = 0;
  private session: CheckoutIntakeSession | null = null;
  private dirty = false;
  private tail: Promise<void> = Promise.resolve();
  private changed: (view: ShippingView) => void;
  private send: (body: Record<string, unknown>) => Promise<unknown>;
  private now: () => number;
  private metric: (event: ShippingBrowserEvent, params: ShippingMetricParams) => void;
  constructor(changed: (view: ShippingView) => void,
    send: (body: Record<string, unknown>) => Promise<unknown>, now = Date.now,
    metric: (event: ShippingBrowserEvent, params: ShippingMetricParams) => void = () => {}) {
    this.changed = changed; this.send = send; this.now = now; this.metric = metric;
  }
  private emit(event: ShippingBrowserEvent, format: unknown, pricingRule: unknown, outcome: 'shown' | 'selected' | 'unavailable') {
    const params = shippingMetricParams({ service: 'expedited', format, outcome, pricingRule });
    try { if (params) this.metric(event, params); } catch { /* never affect checkout */ }
  }
  private disposed = false;
  /** Terminal custody cleanup only; never a way to resume an uncertain checkout. */
  dispose() {
    this.disposed = true; this.epoch++; this.session = null; this.dirty = true;
    this.view = { mode: 'standard', status: 'error', receipt: null, message: '' };
    this.changed = () => {}; this.metric = () => {};
  }
  private publish(update: Partial<ShippingView>) { if (this.disposed) return; this.view = { ...this.view, ...update }; this.changed(this.view); }
  invalidate() {
    this.epoch++;
    this.publish({ receipt: null, status: this.view.mode === 'expedited' || this.dirty ? 'error' : 'idle',
      message: this.view.mode === 'expedited' || this.dirty ? 'Shipping details changed. Get a new quote or confirm Standard shipping.' : '' });
  }
  expedited() { this.invalidate(); this.publish({ mode: 'expedited', status: 'idle', message: '' }); }
  private enqueue(task: () => Promise<void>) {
    // Serialize writes to the same draft; stale response suppression alone cannot undo a late server select.
    const run = this.tail.then(task); this.tail = run.catch(() => {}); return run;
  }
  private async request(op: string, extra: Record<string, unknown> = {}) {
    if (!this.session) throw new Error('Shipping session unavailable');
    return parseShippingReceipt(await this.send({ op, intakeId: this.session.intakeId, capability: this.session.capability, ...extra }));
  }
  async quote(format: 'classic' | 'premium', contact: ShippingContact, prepare: () => Promise<CheckoutIntakeSession>) {
    if (this.disposed) return;
    const epoch = ++this.epoch;
    let pricingRule: unknown = null;
    this.publish({ mode: 'expedited', status: 'loading', receipt: null, message: 'Checking shipping…' });
    return this.enqueue(async () => {
      try {
        if (epoch !== this.epoch) return;
        const session = await prepare();
        if (epoch !== this.epoch) return;
        // Never abandon an uncertain selection on another intake and silently create a fresh purchase.
        if (this.dirty && this.session?.intakeId !== session.intakeId) throw new Error('Clear previous shipping first');
        this.session = session; this.dirty = true;
        const contactReceipt = await this.request('put_contact', { bookFormat: format, contact: {
          name: contact.name, phone: contact.phone, line1: contact.line1, line2: contact.line2,
          city: contact.city, state: contact.state, zip: contact.postalCode, country: contact.country,
        } });
        pricingRule = contactReceipt.bookFormat === format ? contactReceipt.pricingRuleVersion : null;
        if (epoch !== this.epoch) return;
        const receipt = await this.request('quote');
        if (epoch !== this.epoch) return;
        if (receipt.bookFormat !== format || !receipt.quote || receipt.quote.expiresAtMs <= this.now()) throw new Error('Expired');
        this.publish({ status: 'quoted', receipt, message: '' });
        this.emit('shipping_options_view', format, receipt.pricingRuleVersion, 'shown');
      } catch { if (epoch === this.epoch) {
        this.publish({ status: 'error', receipt: null, message: 'Shipping unavailable. Retry the quote or confirm Standard shipping.' });
        this.emit('shipping_unavailable', format, pricingRule, 'unavailable');
      } }
    });
  }
  async select() {
    if (this.view.status === 'loading' || this.view.status === 'selected') return;
    const receipt = this.view.receipt;
    if (this.view.status !== 'quoted' || !receipt?.quote || receipt.quote.expiresAtMs <= this.now()) { this.invalidate(); return; }
    const epoch = ++this.epoch;
    this.publish({ status: 'loading', message: 'Confirming shipping…' });
    return this.enqueue(async () => {
      try {
        if (epoch !== this.epoch) return;
        const selected = await this.request('select', { quoteId: receipt.quote!.quoteId });
        if (epoch !== this.epoch) return;
        if (selected.selectedQuoteId !== receipt.quote!.quoteId || selected.bookFormat !== receipt.bookFormat ||
          selected.totalCents !== receipt.totalCents || selected.deltaTaxIncludedCents !== receipt.deltaTaxIncludedCents ||
          !selected.quote || selected.quote.expiresAtMs <= this.now()) throw new Error('Selection changed');
        this.publish({ status: 'selected', receipt: selected, message: '' });
        this.emit('shipping_option_selected', selected.bookFormat, selected.pricingRuleVersion, 'selected');
      } catch { if (epoch === this.epoch) this.publish({ status: 'error', receipt: null, message: 'Shipping selection could not be confirmed. Retry or confirm Standard shipping.' }); }
    });
  }
  async standard() {
    const epoch = ++this.epoch;
    this.publish({ status: 'loading', receipt: null, message: 'Confirming Standard shipping…' });
    return this.enqueue(async () => {
      try {
        if (epoch !== this.epoch) return;
        if (this.dirty) {
          if (!this.session) throw new Error('Shipping session unavailable');
          const raw = await this.send({ op: 'clear', intakeId: this.session.intakeId, capability: this.session.capability });
          const empty = raw !== null && typeof raw === 'object' && !Array.isArray(raw) &&
            Object.keys(raw).sort().join(',') === 'state,version' &&
            (raw as { state?: unknown }).state === 'empty' && (raw as { version?: unknown }).version === 1;
          if (!empty) {
            const cleared = parseShippingReceipt(raw);
            if (cleared.selectedQuoteId !== null || cleared.quote !== null || cleared.deltaCents !== 0) throw new Error('Clear uncertain');
          }
          this.dirty = false;
        }
        if (epoch === this.epoch) this.publish({ mode: 'standard', status: 'idle', receipt: null, message: '' });
      } catch { if (epoch === this.epoch) this.publish({ status: 'error', message: 'Standard shipping is not confirmed. Retry clearing shipping before payment.' }); }
    });
  }
  expire() { if (this.view.receipt?.quote && this.view.receipt.quote.expiresAtMs <= this.now()) { this.invalidate(); this.publish({ message: 'Shipping quote expired. Get a new quote or confirm Standard shipping.' }); } }
  ready(format: string) {
    if (this.disposed) return false;
    if (this.view.mode === 'standard') return !this.dirty && this.view.status === 'idle';
    const r = this.view.receipt;
    return this.view.status === 'selected' && r?.bookFormat === format && r.selectedQuoteId === r.quote?.quoteId && (r.quote?.expiresAtMs ?? 0) > this.now();
  }
  bind(payload: FormData, epoch: number, format: string) {
    if (epoch !== this.epoch || !this.ready(format)) throw new Error('Shipping changed. Review shipping before payment.');
    if (this.view.mode === 'expedited') {
      const intake = JSON.parse(String(payload.get('checkoutIntake') ?? 'null'));
      if (intake?.intakeId !== this.session?.intakeId || payload.get('checkoutIntakeCapability') !== this.session?.capability) throw new Error('Shipping intake changed. Review shipping before payment.');
      payload.set('expeditedQuoteId', this.view.receipt!.selectedQuoteId!);
    }
  }
}
