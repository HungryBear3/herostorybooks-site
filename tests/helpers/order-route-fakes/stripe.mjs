/**
 * Stripe, journalled. Constructing the client and creating or retrieving a
 * Checkout Session are all recorded; nothing reaches the network.
 */
import { record } from './journal.mjs';

export default class Stripe {
  constructor(key) {
    record('stripe', 'construct', { keyPresent: Boolean(key) });
    this.checkout = {
      sessions: {
        create: async (params) => {
          record('stripe', 'checkout.sessions.create', { orderId: params?.client_reference_id ?? null });
          return { id: 'cs_test_journalled', url: 'https://stripe.test/session', status: 'open' };
        },
        retrieve: async (id) => {
          record('stripe', 'checkout.sessions.retrieve', { id });
          return { id, url: 'https://stripe.test/session', status: 'open' };
        },
      },
    };
  }
}
