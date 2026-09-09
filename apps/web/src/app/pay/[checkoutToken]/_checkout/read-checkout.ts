'use server';

import { CheckoutSchema, isNetworkFamily, isPaymentStatus } from '@cryptopay/shared';

import { ServerApiError, fetchPublic } from '@/lib/server-api';

import type { CheckoutReadResult } from './checkout-result';

/**
 * The one read this screen makes, used for the first paint and then for every poll.
 *
 * It is a server action rather than a browser call because the checkout is public but the dashboard
 * proxy is not: that proxy attaches a merchant key and answers 401 without a session, and a customer
 * paying an invoice has neither. Going through the server also keeps the API's address off the page.
 *
 * The response is parsed against the published contract instead of being trusted. A checkout that
 * does not match is reported as a failed read, because rendering an amount out of a payload nobody
 * validated is exactly the mistake this page cannot afford.
 */

const DETAIL_BY_STATUS: Readonly<Record<number, string>> = {
  404: 'This payment link is not valid. It may have been mistyped, or the payment may no longer exist.',
  410: 'This payment link has been withdrawn.',
  429: 'The API is rate limiting this page. It will try again in a moment.',
  500: 'The API failed while reading this payment.',
  502: 'The API could not be reached.',
  503: 'The API is temporarily unavailable.',
};

function detailFor(status: number): string {
  return DETAIL_BY_STATUS[status] ?? `The API answered ${status.toString()}.`;
}

export async function readCheckout(checkoutToken: string): Promise<CheckoutReadResult> {
  try {
    const body = await fetchPublic<unknown>(`v1/checkout/${encodeURIComponent(checkoutToken)}`);
    const parsed = CheckoutSchema.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false,
        status: 502,
        detail: 'The API answered with a checkout this page could not read.',
      };
    }

    const checkout = parsed.data;
    if (!isPaymentStatus(checkout.status)) {
      return {
        ok: false,
        status: 502,
        detail: `The API reported a payment status this page does not know: ${checkout.status}.`,
      };
    }
    if (!isNetworkFamily(checkout.networkFamily)) {
      return {
        ok: false,
        status: 502,
        detail: `The API reported a network family this page does not know: ${checkout.networkFamily}.`,
      };
    }
    return {
      ok: true,
      checkout: { ...checkout, status: checkout.status, networkFamily: checkout.networkFamily },
    };
  } catch (error) {
    if (error instanceof ServerApiError) {
      return { ok: false, status: error.status, detail: detailFor(error.status) };
    }
    return { ok: false, status: 0, detail: 'The API did not answer.' };
  }
}
