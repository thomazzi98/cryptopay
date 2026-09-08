import type { Metadata } from 'next';

import { Card, ErrorState } from '@/components/ui/surfaces';

import { CheckoutLive } from './_checkout/checkout-live';
import { buildTokenTransferUri } from './_checkout/payment-uri';
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
  const paymentUri = buildTokenTransferUri({
    tokenAddress: checkout.asset.reference,
    chainIdentifier: checkout.chainIdentifier,
    recipient: checkout.receivingAccount,
    amountInBaseUnits: checkout.requestedAmount.baseUnits,
  });

  return (
    <main className="mx-auto w-full max-w-lg px-4 py-6 sm:px-6 sm:py-10">
      <p className="mb-4 px-1 text-xs font-medium tracking-wide text-text-subtle uppercase">
        CryptoPay checkout
      </p>
      <CheckoutLive
        checkoutToken={checkoutToken}
        initialCheckout={checkout}
        scanPanel={<ScanToPay checkout={checkout} paymentUri={paymentUri} />}
      />
    </main>
  );
}
