'use client';

import type { TreasuryReport } from '@cryptopay/shared';

import { Copyable } from '@/components/ui/data';
import { Card, CardBody, CardHeader } from '@/components/ui/surfaces';
import { classNames } from '@/lib/class-names';

/**
 * The account that pays for gas, and how much of the ceiling is left.
 *
 * This is the screen an operator opens when settlement has stopped, so it answers the two questions
 * that stop it: is there anything left to spend, and is there anything left to spend it with. Both
 * figures come from the same arithmetic the settlement worker refuses on, not from a separate count
 * that could disagree with it.
 *
 * The balance carries the time it was read. It is what the worker last observed, because an API that
 * read the chain on request would turn refreshing this page into RPC load and would still be showing
 * a number from a moment ago.
 */

function formatNative(amountInBaseUnits: string | null, decimals: number): string {
  if (amountInBaseUnits === null) {
    return 'unknown';
  }
  const amount = BigInt(amountInBaseUnits);
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const fraction = (amount % divisor).toString().padStart(decimals, '0').slice(0, 6);
  return `${whole.toString()}.${fraction}`;
}

/** Where the ceiling has been spent to, as a proportion, for the bar. */
function usedFraction(report: TreasuryReport): number | null {
  if (report.ceilingInNativeUnits === null) {
    return null;
  }
  const ceiling = BigInt(report.ceilingInNativeUnits);
  if (ceiling === 0n) {
    return 1;
  }
  const committed = BigInt(report.committedInNativeUnits);
  const percent = Number((committed * 1000n) / ceiling) / 10;
  return Math.min(100, Math.max(0, percent));
}

function CeilingBar({ report }: { report: TreasuryReport }) {
  const used = usedFraction(report);
  if (used === null) {
    return (
      <p className="text-sm text-health-degraded">
        No ceiling is configured, so nothing bounds what this network can spend. The API refuses to
        start a production signer in this state.
      </p>
    );
  }

  const tone = used >= 90 ? 'bg-status-underpaid' : used >= 60 ? 'bg-health-degraded' : 'bg-accent';
  return (
    <div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
        role="img"
        aria-label={`${used.toFixed(1)}% of the spend ceiling committed`}
      >
        <div className={classNames('h-full rounded-full', tone)} style={{ width: `${used}%` }} />
      </div>
      <p className="tabular mt-1.5 text-xs text-text-muted">
        {used.toFixed(1)}% of the ceiling committed
      </p>
    </div>
  );
}

export function TreasuryCard({ report }: { report: TreasuryReport }) {
  const decimals = report.nativeCurrency.decimals;
  const symbol = report.nativeCurrency.symbol;
  const balance = report.balanceInNativeUnits;
  const isEmpty = balance !== null && BigInt(balance) === 0n;

  return (
    <Card>
      <CardHeader
        title={report.network}
        description="The account settlement pays gas from, and the ceiling on what it may ever spend."
      />
      <CardBody className="space-y-4">
        {!report.settlementEnabled && (
          <p className="rounded-lg border border-border bg-surface-sunken px-3 py-2 text-xs text-text-muted">
            Settlement is switched off in this deployment. Nothing is signed or broadcast; these
            figures describe what would happen if it were enabled.
          </p>
        )}

        <div>
          <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">
            Treasury account
          </p>
          <div className="mt-1">
            <Copyable value={report.account} />
          </div>
          <p className="mt-1 text-xs text-text-muted">
            Send {symbol} here. A deposit address holds none of its own, so this account funds every
            sweep before it can be signed.
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <div>
            <dt className="text-xs font-medium tracking-wide text-text-subtle uppercase">
              Balance
            </dt>
            <dd
              className={classNames(
                'tabular mt-0.5 text-sm',
                isEmpty ? 'text-status-underpaid' : 'text-text',
              )}
            >
              {formatNative(balance, decimals)} {symbol}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium tracking-wide text-text-subtle uppercase">
              Committed
            </dt>
            <dd className="tabular mt-0.5 text-sm text-text">
              {formatNative(report.committedInNativeUnits, decimals)} {symbol}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium tracking-wide text-text-subtle uppercase">
              Ceiling
            </dt>
            <dd className="tabular mt-0.5 text-sm text-text">
              {report.ceilingInNativeUnits === null
                ? 'none'
                : `${formatNative(report.ceilingInNativeUnits, decimals)} ${symbol}`}
            </dd>
          </div>
        </dl>

        <CeilingBar report={report} />

        {isEmpty && (
          <p role="alert" className="text-xs text-status-underpaid">
            This treasury holds nothing, so no sweep can be funded and every settlement on{' '}
            {report.network} will wait. Send {symbol} to the address above.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
