'use client';

import type { ChainTransaction, Settlement } from '@cryptopay/shared';
import Link from 'next/link';
import { useState } from 'react';

import { Amount, Copyable } from '@/components/ui/data';
import { classNames } from '@/lib/class-names';
import { formatTimestamp } from '@/lib/format';

/**
 * Every settlement, and every transaction it took to make one.
 *
 * The transactions are the point of this table rather than a detail behind it. A settlement that is
 * merely "failed" tells an operator nothing; a settlement whose gas funding confirmed and whose
 * sweep reverted tells them exactly where to look, and the reference lets them look at it on an
 * explorer rather than take this screen's word for it.
 */

const STATUS_TONE: Readonly<Record<string, string>> = Object.freeze({
  pending: 'text-text-muted',
  funding: 'text-status-confirming',
  sweeping: 'text-status-confirming',
  confirming: 'text-status-confirming',
  settled: 'text-status-completed',
  failed: 'text-status-underpaid',
});

const TRANSACTION_TONE: Readonly<Record<string, string>> = Object.freeze({
  submitted: 'text-status-confirming',
  confirming: 'text-status-confirming',
  confirmed: 'text-status-completed',
  reverted: 'text-status-underpaid',
  dropped: 'text-text-muted',
  replaced: 'text-text-muted',
});

function shortenReference(reference: string): string {
  return `${reference.slice(0, 10)}…${reference.slice(-6)}`;
}

/** Wei is unreadable at a glance, and the exact figure is on the title attribute for when it matters. */
function formatNative(amountInBaseUnits: string | null): string {
  if (amountInBaseUnits === null) {
    return '—';
  }
  const amount = BigInt(amountInBaseUnits);
  const whole = amount / 10n ** 18n;
  const fraction = (amount % 10n ** 18n).toString().padStart(18, '0').slice(0, 6);
  return `${whole.toString()}.${fraction}`;
}

function TransactionRow({ transaction }: { transaction: ChainTransaction }) {
  return (
    <tr className="border-t border-border/60">
      <td className="py-2 pr-4">
        <span className="text-xs text-text-muted">
          {transaction.purpose === 'gas_funding' ? 'Gas funding' : 'Sweep'}
        </span>
      </td>
      <td className="py-2 pr-4">
        <span className={classNames('text-xs', TRANSACTION_TONE[transaction.status] ?? '')}>
          {transaction.status}
        </span>
      </td>
      <td className="py-2 pr-4">
        {transaction.explorerUrl === null ? (
          <span className="tabular text-xs text-text-muted">
            {shortenReference(transaction.transactionReference)}
          </span>
        ) : (
          <a
            href={transaction.explorerUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="tabular text-xs text-accent underline-offset-2 hover:underline"
          >
            {shortenReference(transaction.transactionReference)}
          </a>
        )}
      </td>
      <td className="tabular py-2 pr-4 text-xs text-text-muted">{transaction.sequenceNumber}</td>
      <td className="tabular py-2 pr-4 text-xs text-text-muted">
        {transaction.computeUsed ?? '—'}
      </td>
      <td
        className="tabular py-2 pr-4 text-xs text-text-muted"
        title={transaction.feePaidInNativeUnits ?? undefined}
      >
        {formatNative(transaction.feePaidInNativeUnits)}
      </td>
      <td className="tabular py-2 text-xs text-text-muted">{transaction.blockHeight ?? '—'}</td>
    </tr>
  );
}

function SettlementRow({ settlement }: { settlement: Settlement }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <tr className="border-t border-border">
        <td className="py-3 pr-4">
          <Link
            href={`/dashboard/payments/${settlement.paymentIdentifier}`}
            className="tabular text-sm text-accent underline-offset-2 hover:underline"
          >
            {settlement.paymentIdentifier.slice(0, 14)}…
          </Link>
        </td>
        <td className="py-3 pr-4">
          <span className={classNames('text-sm font-medium', STATUS_TONE[settlement.status] ?? '')}>
            {settlement.status}
          </span>
          {settlement.failureReason !== null && (
            <p className="mt-0.5 max-w-xs text-xs break-words text-text-muted">
              {settlement.failureReason}
            </p>
          )}
        </td>
        <td className="py-3 pr-4">
          <Amount display={settlement.amount.display} symbol={settlement.asset.symbol} />
        </td>
        <td className="py-3 pr-4">
          <Copyable value={settlement.destinationAccount} />
        </td>
        <td className="py-3 pr-4 text-xs text-text-muted">
          {formatTimestamp(settlement.settledAt ?? settlement.createdAt)}
        </td>
        <td className="py-3 text-right">
          <button
            type="button"
            onClick={() => {
              setExpanded(!expanded);
            }}
            aria-expanded={expanded}
            className="text-xs text-accent underline-offset-2 hover:underline"
          >
            {settlement.transactions.length} transaction
            {settlement.transactions.length === 1 ? '' : 's'}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-surface-sunken">
          <td colSpan={6} className="px-4 py-3">
            {settlement.transactions.length === 0 ? (
              <p className="text-xs text-text-muted">
                Nothing has been signed for this settlement yet.
              </p>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="text-left text-xs tracking-wide text-text-subtle uppercase">
                    <th className="pb-1 pr-4 font-medium">Purpose</th>
                    <th className="pb-1 pr-4 font-medium">Status</th>
                    <th className="pb-1 pr-4 font-medium">Transaction</th>
                    <th className="pb-1 pr-4 font-medium">Sequence</th>
                    <th className="pb-1 pr-4 font-medium">Gas</th>
                    <th className="pb-1 pr-4 font-medium">Fee paid</th>
                    <th className="pb-1 font-medium">Block</th>
                  </tr>
                </thead>
                <tbody>
                  {settlement.transactions.map((transaction) => (
                    <TransactionRow
                      key={transaction.transactionReference}
                      transaction={transaction}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function SettlementTable({ settlements }: { settlements: readonly Settlement[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem]">
        <thead>
          <tr className="text-left text-xs tracking-wide text-text-subtle uppercase">
            <th className="pb-2 pr-4 font-medium">Payment</th>
            <th className="pb-2 pr-4 font-medium">Status</th>
            <th className="pb-2 pr-4 font-medium">Amount</th>
            <th className="pb-2 pr-4 font-medium">Destination</th>
            <th className="pb-2 pr-4 font-medium">Settled</th>
            <th className="pb-2 text-right font-medium">On chain</th>
          </tr>
        </thead>
        <tbody>
          {settlements.map((settlement) => (
            <SettlementRow key={settlement.identifier} settlement={settlement} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
