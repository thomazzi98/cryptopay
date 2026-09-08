import { getAddress } from 'viem';

import { Card, CardBody, CardHeader } from '@/components/ui/surfaces';
import { Copyable } from '@/components/ui/data';
import { formatExactAmount } from '@/lib/format';

import type { CheckoutView } from './checkout-view';
import { encodeQrMatrix } from './qr-matrix';

/**
 * Rendered on the server, with no client component below it, so the code and the address are in the
 * first byte of HTML and survive JavaScript being switched off entirely. Neither value changes for
 * the life of the payment, so there is nothing here to poll.
 *
 * The code takes its two colours from the theme tokens rather than being pinned to black on white.
 * That keeps the contrast ratio high in both themes, which is what a camera actually needs.
 */

const QUIET_ZONE_MODULES = 4;

function toSvgPath(size: number, modules: Uint8Array): string {
  const segments: string[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (modules[y * size + x] === 1) {
        segments.push(
          `M${(x + QUIET_ZONE_MODULES).toString()} ${(y + QUIET_ZONE_MODULES).toString()}h1v1h-1z`,
        );
      }
    }
  }
  return segments.join('');
}

export function ScanToPay({
  checkout,
  paymentUri,
}: {
  checkout: CheckoutView;
  paymentUri: string;
}) {
  const matrix = encodeQrMatrix(paymentUri);
  const extent = matrix.size + QUIET_ZONE_MODULES * 2;
  const path = toSvgPath(matrix.size, matrix.modules);
  const displayAddress = getAddress(checkout.receivingAccount);
  const exactAmount = formatExactAmount(checkout.requestedAmount.display);

  return (
    <Card>
      <CardHeader
        title="Scan or copy"
        description={`Send ${checkout.asset.symbol} on ${checkout.networkDisplayName}. This address belongs to this payment alone.`}
      />
      <CardBody className="space-y-4">
        <div className="flex justify-center">
          <div className="rounded-xl border border-border bg-surface-raised p-2">
            <svg
              role="img"
              aria-label={`Payment request for ${exactAmount} ${checkout.asset.symbol} to ${displayAddress}`}
              viewBox={`0 0 ${extent.toString()} ${extent.toString()}`}
              shapeRendering="crispEdges"
              className="block h-auto w-56 max-w-full sm:w-64"
            >
              <rect width={extent} height={extent} fill="var(--color-surface-raised)" />
              <path d={path} fill="var(--color-text)" />
            </svg>
          </div>
        </div>

        <div>
          <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">
            Receiving address
          </p>
          <p className="mt-1 font-mono text-xs break-all text-text select-all">{displayAddress}</p>
          <div className="mt-1">
            <Copyable value={displayAddress} />
          </div>
        </div>

        <div>
          <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">
            Exact amount
          </p>
          <p className="tabular mt-1 font-mono text-xs break-all text-text select-all">
            {exactAmount} {checkout.asset.symbol}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            {checkout.requestedAmount.baseUnits} base units, {checkout.asset.decimals.toString()}{' '}
            decimals. Send the asset at this contract, not another token with the same symbol.
          </p>
          <div className="mt-1">
            <Copyable
              value={checkout.asset.reference}
              display={`token ${getAddress(checkout.asset.reference)}`}
            />
          </div>
        </div>

        <a
          href={paymentUri}
          className="inline-flex items-center justify-center rounded-lg border border-border bg-surface-raised px-3.5 py-2 text-sm font-medium text-text transition-colors hover:bg-surface-hover"
        >
          Open in a wallet app
        </a>

        <noscript>
          <div className="rounded-lg border border-border-strong bg-surface-sunken p-3 text-xs text-text">
            <p className="font-medium">JavaScript is off, so this page will not update itself.</p>
            <p className="mt-2">
              Send exactly{' '}
              <span className="tabular font-mono select-all">
                {exactAmount} {checkout.asset.symbol}
              </span>{' '}
              on {checkout.networkDisplayName} to:
            </p>
            <p className="mt-1 font-mono break-all select-all">{displayAddress}</p>
            <p className="mt-2 text-text-muted">
              Reload this page to see whether it has arrived. The payment is credited by the backend
              reading the chain, so nothing is lost by closing this page.
            </p>
          </div>
        </noscript>
      </CardBody>
    </Card>
  );
}
