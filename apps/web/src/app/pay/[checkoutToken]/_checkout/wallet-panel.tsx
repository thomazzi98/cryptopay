'use client';

import { POLYGON_AMOY_GAS_FAUCET_URL, POLYGON_AMOY_STABLECOIN_FAUCET_URL } from '@cryptopay/shared';
import { BaseError, erc20Abi, formatUnits, getAddress, parseUnits } from 'viem';
import { useState, type ReactNode } from 'react';
import {
  useBalance,
  useChains,
  useConnect,
  useConnection,
  useConnectors,
  useDisconnect,
  useEstimateFeesPerGas,
  useReadContract,
  useSwitchChain,
  useWriteContract,
  type Connector,
} from 'wagmi';

import { Button } from '@/components/ui/button';
import { Copyable } from '@/components/ui/data';
import { Card, CardBody, CardHeader } from '@/components/ui/surfaces';
import { classNames } from '@/lib/class-names';
import { formatAmount, formatExactAmount } from '@/lib/format';
import { describeStatus } from '@/lib/payment-status';

import type { CheckoutView } from './checkout-view';

/**
 * The wallet path, and the checklist that runs before the wallet is ever opened.
 *
 * Every item is shown whether it passes or not. A customer who is about to move money is entitled to
 * see what was verified, and an itemised list is also the only way the two failures that are not the
 * customer's fault can be told apart from the two that are: a chain mismatch and an empty gas
 * balance are ordinary states on a testnet, while a decimals mismatch or an amount that does not
 * re-derive means the payload disagrees with the chain and the wallet must not be opened at all.
 *
 * Wallet errors are unwrapped rather than read off the top-level object, because a provider error
 * arrives wrapped in several layers of viem error. Code 4001 is a customer changing their mind and
 * is not shown as a failure; code -32002 means a request is already sitting in the wallet, and
 * sending another would queue behind it and be signed by accident, so nothing here retries.
 */

const USER_REJECTED_REQUEST = 4001;
const REQUEST_ALREADY_OPEN = -32_002;

/**
 * An ERC-20 transfer costs roughly 50,000 gas, more against a token that writes extra state. The
 * allowance is deliberately generous: telling a customer they have enough gas when they do not is
 * far worse than sending them to a faucet they did not strictly need.
 */
const TRANSFER_GAS_ALLOWANCE = 100_000n;

type CheckState = 'passing' | 'failing' | 'waiting';

interface PreflightCheck {
  readonly key: string;
  readonly label: string;
  readonly state: CheckState;
  readonly detail: string;
  readonly remedy: ReactNode;
}

const CHECK_GLYPH: Readonly<Record<CheckState, string>> = {
  passing: '✓',
  failing: '×',
  waiting: '○',
};

const CHECK_TONE: Readonly<Record<CheckState, string>> = {
  passing: 'text-status-completed',
  failing: 'text-status-canceled',
  waiting: 'text-text-subtle',
};

function stateOf(isKnown: boolean, holds: boolean): CheckState {
  if (!isKnown) {
    return 'waiting';
  }
  return holds ? 'passing' : 'failing';
}

function carriesCode(candidate: unknown, code: number): boolean {
  if (typeof candidate !== 'object' || candidate === null || !('code' in candidate)) {
    return false;
  }
  const value: unknown = candidate.code;
  return typeof value === 'number' && value === code;
}

function hasProviderCode(error: unknown, code: number): boolean {
  if (!(error instanceof BaseError)) {
    return false;
  }
  return error.walk((candidate) => carriesCode(candidate, code)) !== null;
}

function describeWalletError(error: unknown): string {
  if (error instanceof BaseError) {
    return error.shortMessage;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'The wallet refused the request without saying why.';
}

function parseDisplayAmount(display: string, decimals: number): bigint | null {
  try {
    return parseUnits(display, decimals);
  } catch {
    return null;
  }
}

function FaucetLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-xs font-medium text-accent underline underline-offset-2"
    >
      {children}
    </a>
  );
}

/**
 * A broadcast this browser has already made, remembered across a reload.
 *
 * Session storage rather than local storage: the memory should last as long as the tab that made the
 * payment and no longer, and it is keyed per checkout so it can never suppress the button on a
 * different payment. Every access is guarded because a browser set to block site data throws on the
 * accessor itself, and a checkout page that fails to render is worse than one that forgets.
 */
function recallBroadcast(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function rememberBroadcast(key: string, reference: string): void {
  try {
    sessionStorage.setItem(key, reference);
  } catch {
    // The customer keeps a working page; they lose only the memory of the broadcast on reload.
  }
}

export function WalletPanel({
  checkout,
  checkoutToken,
}: {
  checkout: CheckoutView;
  checkoutToken: string;
}) {
  const connection = useConnection();
  const connectors = useConnectors();
  const chains = useChains();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const writeContract = useWriteContract();

  const [notice, setNotice] = useState<string | null>(null);
  const [pendingConnectorUid, setPendingConnectorUid] = useState<string | null>(null);
  // Restored from this browser rather than initialised empty, so a reload does not present a
  // customer who has already paid with a button that pays again.
  const [sentReference, setSentReference] = useState<string | null>(() =>
    recallBroadcast(`cryptopay:broadcast:${checkoutToken}`),
  );

  const tokenAddress = getAddress(checkout.asset.reference);
  const recipient = getAddress(checkout.receivingAccount);
  const requestedBaseUnits = BigInt(checkout.requestedAmount.baseUnits);

  /**
   * What is still owed, not what was invoiced.
   *
   * Sending the full amount whenever the wallet is connected is how one page refresh becomes a
   * double payment: the panel is live for every non-final status, and `partially_funded` and
   * `confirming` are both non-final. A customer who paid and reloaded, or who topped up a partial
   * payment, would be offered a button that sends the whole invoice a second time — and this system
   * has no refund path to give it back.
   */
  const creditedBaseUnits = BigInt(checkout.creditedAmount.baseUnits);
  const outstandingBaseUnits =
    creditedBaseUnits >= requestedBaseUnits ? 0n : requestedBaseUnits - creditedBaseUnits;
  const outstandingDisplay = formatUnits(outstandingBaseUnits, checkout.asset.decimals);
  const isFullyFunded = outstandingBaseUnits === 0n;

  /**
   * Whether this browser has already broadcast against this checkout.
   *
   * The credited figure lags the broadcast by however long the scanner takes to see the log, so for
   * the first seconds after signing the outstanding amount is still the full invoice. Remembering
   * the reference closes that window across a reload; it is per checkout token, so it cannot leak
   * between payments.
   */
  const broadcastMemoryKey = `cryptopay:broadcast:${checkoutToken}`;
  const account = connection.address;
  const isConnected = connection.status === 'connected';
  const isOnAmoy = checkout.network === 'polygon-amoy';
  /**
   * A browser wallet connects to an EVM chain, so this panel needs a numeric chain id. Networks
   * whose family has none are paid by scanning the QR code instead, and the caller renders that
   * path rather than this one.
   */
  const evmChainId = checkout.chainIdentifier ?? undefined;
  const chainIsConfigured = chains.some((candidate) => candidate.id === evmChainId);
  // The wallet's own chain, never the configuration's idea of it.
  const chainMatches = evmChainId !== undefined && connection.chainId === evmChainId;

  const decimalsRead = useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'decimals',
    chainId: evmChainId,
    query: { enabled: isConnected },
  });

  const tokenBalanceRead = useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: account === undefined ? undefined : [account],
    chainId: evmChainId,
    query: { enabled: account !== undefined, refetchInterval: 12_000 },
  });

  const gasBalanceRead = useBalance({
    address: account,
    chainId: evmChainId,
    query: { enabled: account !== undefined, refetchInterval: 12_000 },
  });

  const feesRead = useEstimateFeesPerGas({
    chainId: evmChainId,
    query: { enabled: account !== undefined },
  });

  const onChainDecimals = decimalsRead.data;
  const derivedBaseUnits =
    onChainDecimals === undefined
      ? null
      : parseDisplayAmount(checkout.requestedAmount.display, onChainDecimals);

  const tokenBalance = tokenBalanceRead.data;
  const nativeBalance = gasBalanceRead.data;
  const maxFeePerGas = feesRead.data?.maxFeePerGas;
  const gasNeeded = maxFeePerGas === undefined ? null : maxFeePerGas * TRANSFER_GAS_ALLOWANCE;
  const gasHeld = nativeBalance?.value;
  const gasIsSufficient =
    gasHeld !== undefined && (gasNeeded === null ? gasHeld > 0n : gasHeld >= gasNeeded);

  const shortfall =
    tokenBalance === undefined || tokenBalance >= outstandingBaseUnits
      ? null
      : formatUnits(outstandingBaseUnits - tokenBalance, checkout.asset.decimals);

  const checks: readonly PreflightCheck[] = [
    {
      key: 'chain',
      label: `Your wallet is on ${checkout.networkDisplayName}`,
      state: stateOf(isConnected, chainMatches),
      detail: chainMatches
        ? `Chain ${evmChainId}, the one this payment settles on.`
        : `Your wallet reports chain ${connection.chainId ?? 'none'}. This payment settles on chain ${evmChainId ?? 'unknown'}.`,
      remedy:
        isConnected && !chainMatches && chainIsConfigured ? (
          <Button
            size="small"
            variant="secondary"
            loading={switchChain.isPending}
            onClick={() => {
              if (evmChainId !== undefined) {
                switchChain.mutate({ chainId: evmChainId });
              }
            }}
          >
            Switch network
          </Button>
        ) : null,
    },
    {
      key: 'decimals',
      label: 'Token decimals read from the contract',
      state: stateOf(onChainDecimals !== undefined, onChainDecimals === checkout.asset.decimals),
      detail:
        onChainDecimals === undefined
          ? (decimalsRead.error?.message ??
            'Reading decimals() from the token contract on this network.')
          : `decimals() returned ${onChainDecimals}; the payment was priced at ${checkout.asset.decimals}.`,
      remedy: null,
    },
    {
      key: 'integrity',
      label: 'The two forms of the amount agree',
      state: stateOf(derivedBaseUnits !== null, derivedBaseUnits === requestedBaseUnits),
      detail:
        derivedBaseUnits === null
          ? 'Waiting for the decimals the contract reports.'
          : `parseUnits("${checkout.requestedAmount.display}") is ${derivedBaseUnits} against the ${checkout.requestedAmount.baseUnits} the API sent.`,
      remedy: null,
    },
    {
      key: 'token-balance',
      label: `Enough ${checkout.asset.symbol} to cover the payment`,
      state: stateOf(
        tokenBalance !== undefined,
        tokenBalance !== undefined && tokenBalance >= outstandingBaseUnits,
      ),
      detail:
        tokenBalance === undefined
          ? 'Reading your token balance.'
          : `You hold ${formatAmount(formatUnits(tokenBalance, checkout.asset.decimals), checkout.asset.decimals)} ${checkout.asset.symbol}${shortfall === null ? '.' : `, which is ${formatAmount(shortfall, checkout.asset.decimals)} short.`}`,
      remedy:
        shortfall !== null && isOnAmoy ? (
          <FaucetLink href={POLYGON_AMOY_STABLECOIN_FAUCET_URL}>
            Get test {checkout.asset.symbol}
          </FaucetLink>
        ) : null,
    },
    {
      key: 'gas',
      label: `Enough ${nativeBalance?.symbol ?? 'native currency'} for the transaction fee`,
      state: stateOf(gasHeld !== undefined, gasIsSufficient),
      detail: describeGas(gasHeld, gasNeeded, nativeBalance?.symbol, nativeBalance?.decimals),
      remedy:
        gasHeld !== undefined && !gasIsSufficient && isOnAmoy ? (
          <FaucetLink href={POLYGON_AMOY_GAS_FAUCET_URL}>Get test POL for gas</FaucetLink>
        ) : null,
    },
  ];

  const everythingPasses = checks.every((check) => check.state === 'passing');
  const descriptor = describeStatus(checkout.status);

  async function attachWallet(connector: Connector): Promise<void> {
    setNotice(null);
    setPendingConnectorUid(connector.uid);
    try {
      await connect.mutateAsync({ connector });
    } catch (error) {
      connect.reset();
      if (hasProviderCode(error, USER_REJECTED_REQUEST)) {
        return;
      }
      if (hasProviderCode(error, REQUEST_ALREADY_OPEN)) {
        setNotice(
          'Your wallet already has a request open. Finish or dismiss it there. This page will not send a second one.',
        );
        return;
      }
      setNotice(describeWalletError(error));
    } finally {
      setPendingConnectorUid(null);
    }
  }

  async function sendPayment(): Promise<void> {
    setNotice(null);
    try {
      const reference = await writeContract.mutateAsync({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [recipient, outstandingBaseUnits],
        chainId: evmChainId,
      });
      setSentReference(reference);
      rememberBroadcast(broadcastMemoryKey, reference);
    } catch (error) {
      writeContract.reset();
      if (hasProviderCode(error, USER_REJECTED_REQUEST)) {
        return;
      }
      if (hasProviderCode(error, REQUEST_ALREADY_OPEN)) {
        setNotice(
          'A request is already open in your wallet. Finish or dismiss it there, then try again. Sending another now would queue behind it and could be signed by mistake.',
        );
        return;
      }
      setNotice(describeWalletError(error));
    }
  }

  return (
    <Card>
      <CardHeader
        title="Pay with a connected wallet"
        description="Nothing is sent to your wallet until every check below passes."
      />
      <CardBody className="space-y-4">
        {descriptor.isFinal && (
          <p className="text-sm text-text-muted">
            This payment is {descriptor.label.toLowerCase()} and no longer accepts a transfer.
          </p>
        )}

        {!descriptor.isFinal && !isConnected && connectors.length === 0 && (
          <p className="text-sm text-text-muted">
            No wallet was found in this browser. Scan the code above with a wallet on your phone, or
            copy the address into the wallet you already use.
          </p>
        )}

        {!descriptor.isFinal && !isConnected && connectors.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {connectors.map((connector) => (
              <Button
                key={connector.uid}
                variant="secondary"
                loading={pendingConnectorUid === connector.uid}
                disabled={pendingConnectorUid !== null}
                onClick={() => {
                  void attachWallet(connector);
                }}
              >
                {connector.name}
              </Button>
            ))}
          </div>
        )}

        {!descriptor.isFinal && isConnected && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">
                  Paying from
                </p>
                {account !== undefined && <Copyable value={account} />}
              </div>
              <Button
                size="small"
                variant="ghost"
                onClick={() => {
                  disconnect.mutate({});
                }}
              >
                Disconnect
              </Button>
            </div>

            <ul className="space-y-2">
              {checks.map((check) => (
                <li key={check.key} className="flex gap-2.5">
                  <span
                    aria-hidden="true"
                    className={classNames('mt-0.5 text-sm', CHECK_TONE[check.state])}
                  >
                    {CHECK_GLYPH[check.state]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-text">{check.label}</p>
                    <p className="tabular mt-0.5 text-xs break-words text-text-muted">
                      {check.detail}
                    </p>
                    {check.remedy !== null && <div className="mt-1.5">{check.remedy}</div>}
                  </div>
                </li>
              ))}
            </ul>

            {sentReference === null && !isFullyFunded && (
              <Button
                variant="primary"
                className="w-full"
                loading={writeContract.isPending}
                disabled={!everythingPasses}
                onClick={() => {
                  void sendPayment();
                }}
              >
                Send {formatExactAmount(outstandingDisplay)} {checkout.asset.symbol}
              </Button>
            )}

            {sentReference === null && isFullyFunded && (
              <div className="rounded-lg border border-status-completed bg-status-completed-soft px-3 py-2.5">
                <p className="text-sm font-medium text-status-completed">
                  This payment is already funded.
                </p>
                <p className="mt-1 text-xs text-text-muted">
                  The full amount has been received and is confirming. Sending again would transfer
                  a second time, and this page will not ask you to.
                </p>
              </div>
            )}

            {sentReference !== null && (
              <div className="rounded-lg border border-border bg-surface-sunken px-3 py-2.5">
                <p className="text-sm font-medium text-text">Signed and broadcast.</p>
                <div className="mt-1">
                  <Copyable value={sentReference} />
                </div>
                <p className="mt-2 text-xs text-text-muted">
                  You can close this page. CryptoPay credits the payment by reading the chain
                  itself, so nothing depends on this tab staying open.
                </p>
              </div>
            )}
          </div>
        )}

        {notice !== null && (
          <p role="alert" className="text-sm text-status-canceled">
            {notice}
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function describeGas(
  held: bigint | undefined,
  needed: bigint | null,
  symbol: string | undefined,
  decimals: number | undefined,
): string {
  if (held === undefined || decimals === undefined) {
    return 'Reading your native balance.';
  }
  const unit = symbol ?? '';
  const balance = `${formatAmount(formatUnits(held, decimals), 6)} ${unit}`.trim();
  if (needed === null) {
    return `You hold ${balance}. The fee estimate is not available yet.`;
  }
  return `You hold ${balance} against an estimated fee of ${formatAmount(formatUnits(needed, decimals), 6)} ${unit}.`;
}
