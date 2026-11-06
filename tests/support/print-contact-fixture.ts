import type { OrderRecord } from '../../src/lib/orders.ts';
import {
  __setPrintContactStoreForTests,
  orderPrintContactBinding,
  stripShippingContact,
  type PrintContactResolution,
  type PrintContactStore,
  type ResolvedPrintContact,
} from '../../src/lib/print-contact-store.ts';

export const SYNTHETIC_SHIPPING = {
  line1: '10 Synthetic Way', line2: null, city: 'Testville', state: 'IL', zip: '60601', country: 'US',
};

export interface MemoryPrintContactStore extends PrintContactStore {
  objects: Map<string, string>;
}

/** Explicit synthetic store. Production has no local fallback. */
export function createMemoryPrintContactStore(): MemoryPrintContactStore {
  const objects = new Map<string, string>();
  return {
    kind: 'synthetic-memory',
    objects,
    async read(pathname) {
      return objects.get(pathname) ?? null;
    },
    async createIfAbsent(pathname, body) {
      if (objects.has(pathname)) return 'exists';
      objects.set(pathname, body);
      return 'created';
    },
  };
}

export function installMemoryPrintContactStore(): MemoryPrintContactStore {
  const store = createMemoryPrintContactStore();
  __setPrintContactStoreForTests(store);
  return store;
}

/** A synthetic contact bound to the fixture order; never a real person. */
export function syntheticPrintContact(order: OrderRecord): ResolvedPrintContact {
  const binding = orderPrintContactBinding(order) ?? {
    orderId: order.id,
    purchaseKind: 'order' as const,
    stripeSessionId: 'cs_test_fixture',
    stripePaymentIntentId: null,
    quoteId: null,
    shippingAddress: stripShippingContact(order.shippingAddress ?? SYNTHETIC_SHIPPING),
  };
  return { ...binding, recipientName: 'Synthetic Recipient', phone: '+13125550100' };
}

export const resolveSyntheticPrintContact = async (order: OrderRecord): Promise<PrintContactResolution> => ({
  ok: true,
  contact: syntheticPrintContact(order),
});
