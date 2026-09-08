import type { CheckoutView } from './checkout-view';

/**
 * Kept out of the server action module so that module can export nothing but the action itself,
 * which is what the App Router requires of a file marked `use server`.
 */
export type CheckoutReadResult =
  | { readonly ok: true; readonly checkout: CheckoutView }
  | { readonly ok: false; readonly status: number; readonly detail: string };
