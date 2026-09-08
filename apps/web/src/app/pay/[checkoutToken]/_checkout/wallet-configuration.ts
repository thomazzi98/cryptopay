import { createConfig, http } from 'wagmi';
import { foundry, polygon, polygonAmoy } from 'wagmi/chains';
import { injected } from 'wagmi/connectors';

/**
 * The wallet configuration for the public checkout.
 *
 * Only the three networks a payment can settle on are declared, so a wallet sitting on anything else
 * is caught by the chain guard rather than being handed a transfer against an unknown chain. The
 * transports use each chain's public endpoint: this configuration ships to every customer's browser,
 * so it must never carry a provider-keyed URL.
 *
 * `ssr` is on because this page is server rendered. Without it the first client render would read a
 * restored connection the server never saw and the whole panel would mismatch on hydration.
 */
export const walletConfiguration = createConfig({
  chains: [polygon, polygonAmoy, foundry],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [polygon.id]: http(),
    [polygonAmoy.id]: http(),
    [foundry.id]: http(),
  },
  ssr: true,
});
