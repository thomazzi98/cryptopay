import { SimulatorScreen } from './_simulator/simulator-screen';

/**
 * Backend independence, shown rather than claimed.
 *
 * The screen is a client component in full because all three panes move: the payment is polled
 * while it is on screen, and a server render of a value that changes in four seconds buys nothing.
 */
export default function SimulatorPage() {
  return <SimulatorScreen />;
}
