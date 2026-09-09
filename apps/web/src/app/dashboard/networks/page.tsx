import { NetworksScreen } from './_networks/networks-screen';

/**
 * The screen an operator opens when payments stop arriving.
 *
 * A halted scanner is the failure that is invisible everywhere else in this product: payments keep
 * being created, the API keeps answering, and not one of them is ever detected. A list of pending
 * payments looks identical to a quiet afternoon.
 */
export default function NetworksPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-text">Networks</h1>
        <p className="mt-1 text-sm text-text-muted">
          Every chain this key can be paid on, what each one accepts, and whether it is being
          watched right now.
        </p>
      </div>

      <NetworksScreen />
    </div>
  );
}
