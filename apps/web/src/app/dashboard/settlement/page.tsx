import { SettlementScreen } from './_settlement/settlement-screen';

/**
 * Every figure here changes while it is on screen, so nothing is server rendered: a balance or a
 * settlement status baked into the first paint would be stale before it was read.
 */
export default function SettlementPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-text">Settlement</h1>
        <p className="mt-1 text-sm text-text-muted">
          Where the money goes after a payment completes, what it cost to move it, and what is left
          to spend moving the next one.
        </p>
      </div>

      <SettlementScreen />
    </div>
  );
}
