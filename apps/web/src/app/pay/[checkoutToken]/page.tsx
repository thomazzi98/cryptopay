import { buildPaymentUri, UnsupportedPaymentUriError } from '@cryptopay/shared';
import type { Metadata } from 'next';

import { Card, ErrorState } from '@/components/ui/surfaces';

import { CheckoutLive } from './_checkout/checkout-live';
import type { CheckoutView } from './_checkout/checkout-view';
import { readCheckout } from './_checkout/read-checkout';
import { ScanToPay } from './_checkout/scan-to-pay';

/**
 * The page a customer pays on. Public: no session, no API key, no merchant data beyond a name.
 *
 * The checkout is read on the server so the amount, the asset, the network, the address and the
 * merchant are in the first paint. Someone about to move money should not watch the figure they are
 * sending resolve in front of them, and a page that fills in piecemeal reads as a page that might be
 * lying. The QR code is generated here too, for the same reason and one more: it must still be there
 * with JavaScript switched off.
 */

export const metadata: Metadata = { title: 'Checkout' };

/**
 * Returns null rather than throwing when a family has no URI standard to draw, because a checkout
 * that cannot offer a deep link is still a checkout: the address and the amount are on the page and
 * a customer can pay by hand.
 */
function buildCheckoutUri(checkout: CheckoutView): string | null {
  try {
    return buildPaymentUri({
      networkFamily: checkout.networkFamily,
      evmChainId: checkout.chainIdentifier,
      destinationAccount: checkout.receivingAccount,
      assetReference: checkout.asset.reference,
      assetDecimals: checkout.asset.decimals,
      amountInBaseUnits: checkout.requestedAmount.baseUnits,
      memo: null,
    });
  } catch (error) {
    if (error instanceof UnsupportedPaymentUriError) {
      return null;
    }
    throw error;
  }
}

export default async function CheckoutPage({
  params,
}: {
  params: Promise<{ checkoutToken: string }>;
}) {
  const { checkoutToken } = await params;
  const result = await readCheckout(checkoutToken);

  if (!result.ok) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-lg items-center px-4 py-10 sm:px-6">
        <Card className="w-full">
          <ErrorState title="This payment could not be shown" detail={result.detail} />
        </Card>
      </main>
    );
  }

  const checkout = result.checkout;
  // The same builder the API draws its own QR from. This page used to carry a second one that
  // emitted an EIP-681 token transfer for every payment, which asked a wallet to call `transfer` on
  // a contract that does not exist whenever the payment was in the chain's own currency, and had no
  // idea Solana Pay or TRON existed at all.
  const paymentUri = buildCheckoutUri(checkout);

  return (
    <main className="mx-auto w-full max-w-lg px-4 py-6 sm:px-6 sm:py-10">
      <p className="mb-4 px-1 text-xs font-medium tracking-wide text-text-subtle uppercase">
        CryptoPay checkout
      </p>
      <CheckoutLive
        checkoutToken={checkoutToken}
        initialCheckout={checkout}
        scanPanel={
          paymentUri === null ? (
            <Card className="w-full">
              <ErrorState
                title="This network has no wallet link"
                detail="Copy the address and the exact amount from the payment details instead. A deep link needs a numeric chain identity, which this network does not have."
              />
            </Card>
          ) : (
            <ScanToPay checkout={checkout} paymentUri={paymentUri} />
          )
        }
      />
    </main>
  );
}
