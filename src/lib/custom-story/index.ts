/**
 * Custom-story (fully-custom, shape-gated, concierge-first) public surface.
 *
 * Pure types + validators + gate constants + intervention-log schema. Nothing
 * here touches checkout, Stripe, orders, email, print, or providers.
 */

export * from './types.ts';
export * from './ban-list.ts';
export * from './shapes.ts';
export * from './validate.ts';
export * from './intervention-log.ts';
