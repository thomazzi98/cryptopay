import { mnemonicToSeedSync } from '@scure/bip39';
import { describe, expect, it } from 'vitest';

import {
  buildPaymentUri,
  canonicaliseAccount,
  canonicaliseReference,
  isCanonicalAccount,
  isCanonicalReference,
  NATIVE_ASSET_REFERENCE,
  UnsupportedPaymentUriError,
  type NetworkFamily,
  type NetworkIdentifier,
  type ReferenceForm,
} from '@cryptopay/shared';

import { allocateSolanaDestination } from '../wallet/ed25519-allocator.js';
import { HierarchicalDeterministicAllocator } from '../wallet/hierarchical-deterministic-allocator.js';
import type { PaymentDestination } from '../wallet/payment-destination.js';
import {
  explorerAccountUrl,
  explorerTransactionUrl,
  findAllowedAsset,
  networkConfigurationFor,
} from './network-configuration.js';

/**
 * One behavioural contract, satisfied by all three families.
 *
 * The point is not that the chains are the same. They are not, and the places they differ are
 * asserted as differences rather than skipped or papered over: only Polygon has a numeric chain
 * identity, only Solana Pay carries a memo, and a transaction is called a hash, an id or a signature
 * depending on who you ask. Each of those is a row in a table here rather than a branch buried in an
 * adapter.
 *
 * What every family must do identically is the part that protects money: issue a destination its own
 * chain would accept, refuse a currency it does not settle, name an asset by identity rather than by
 * symbol, produce a URI a wallet can act on, and write an account down in a form that survives the
 * round trip to storage and back.
 *
 * This runs without a node, which is what makes it a contract rather than an integration test. The
 * behaviours that genuinely need a chain are asserted against real nodes in `apps/api/local`, and
 * against the public networks in `apps/api/live`.
 */

const WELL_KNOWN_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function seed(): Buffer {
  return Buffer.from(mnemonicToSeedSync(WELL_KNOWN_MNEMONIC));
}

interface AdapterContract {
  readonly family: NetworkFamily;
  /** The public deployment, so explorer links and a frozen asset list are both real. */
  readonly network: NetworkIdentifier;
  readonly nativeCurrency: string;
  readonly tokenCurrency: string;
  readonly uriScheme: string;
  /** Present only where the family has a numeric chain identity. Null is the honest answer. */
  readonly chainIdentifier: number | null;
  readonly referenceForm: ReferenceForm;
  /** A real transaction on that network, in the form its own ecosystem writes. */
  readonly transactionReference: string;
  /** Whether this system can sign and broadcast here at all. True on Polygon only. */
  readonly supportsSettlement: boolean;
  readonly allocate: (derivationIndex: number) => PaymentDestination;
}

const CONTRACTS: readonly AdapterContract[] = [
  {
    family: 'polygon',
    network: 'polygon-amoy',
    nativeCurrency: 'POL',
    tokenCurrency: 'USDC',
    uriScheme: 'ethereum:',
    chainIdentifier: 80_002,
    referenceForm: 'evm-hash',
    transactionReference: '0x570a7a56d0b465f9c4b7a84cc581da427b8460c2244326fa7262ec3c540c1b11',
    supportsSettlement: true,
    allocate: (index) => new HierarchicalDeterministicAllocator(seed(), 'polygon').allocate(index),
  },
  {
    family: 'tron',
    network: 'tron-nile',
    nativeCurrency: 'TRX',
    tokenCurrency: 'USDT',
    uriScheme: 'tron:',
    chainIdentifier: null,
    referenceForm: 'bare-hex',
    transactionReference: 'f0718be7e2f71a893c06d634382554a24c862bc54ab26cdb8224deff5f629802',
    supportsSettlement: false,
    allocate: (index) => new HierarchicalDeterministicAllocator(seed(), 'tron').allocate(index),
  },
  {
    family: 'solana',
    network: 'solana-devnet',
    nativeCurrency: 'SOL',
    tokenCurrency: 'USDC',
    uriScheme: 'solana:',
    chainIdentifier: null,
    referenceForm: 'base58-exact',
    transactionReference:
      '23XfW1pvgFCsiVNr4WHZwSpyK7grrk6Ao4wbAKK6mbHwocyAr57TdVtjQQjg4hJN7fcfdvMWaVx2obwujA1uTLyP',
    supportsSettlement: false,
    allocate: (index) => allocateSolanaDestination(seed(), index),
  },
];

describe.each(CONTRACTS)('the $family adapter contract', (contract) => {
  const configuration = networkConfigurationFor(contract.network);

  describe('issuing a payment destination', () => {
    it('produces an account canonical for this network', () => {
      const destination = contract.allocate(0);

      expect(isCanonicalAccount(configuration.addressForm, destination.account)).toBe(true);
    });

    it('produces an account no other family would accept', () => {
      const destination = contract.allocate(1);
      const others = CONTRACTS.filter((candidate) => candidate.family !== contract.family);

      for (const other of others) {
        const otherForm = networkConfigurationFor(other.network).addressForm;
        expect(isCanonicalAccount(otherForm, destination.account)).toBe(false);
      }
    });

    it('survives the round trip through canonicalisation unchanged', () => {
      const account = contract.allocate(2).account;

      expect(canonicaliseAccount(configuration.addressForm, account)).toBe(account);
    });

    it('issues a distinct account for every index', () => {
      const accounts = new Set(
        Array.from({ length: 32 }, (_unused, index) => contract.allocate(index).account),
      );

      expect(accounts.size).toBe(32);
    });

    it('records a derivation path and never publishes it in the account', () => {
      const destination = contract.allocate(3);

      expect(destination.allocationReference).toContain("m/44'");
      expect(destination.account).not.toContain('m/44');
    });
  });

  describe('validating a currency', () => {
    it.each(['native', 'token'] as const)('settles its own %s currency', (kind) => {
      const currency = kind === 'native' ? contract.nativeCurrency : contract.tokenCurrency;
      const asset = findAllowedAsset(contract.network, currency);

      expect(asset).not.toBeNull();
      expect(asset?.symbol).toBe(currency);
    });

    it('names a native asset by the sentinel rather than by a contract that does not exist', () => {
      const asset = findAllowedAsset(contract.network, contract.nativeCurrency);

      expect(asset?.reference).toBe(NATIVE_ASSET_REFERENCE);
    });

    it('names a token by an identity its own chain would accept, never by its symbol', () => {
      const asset = findAllowedAsset(contract.network, contract.tokenCurrency);

      expect(asset?.reference).not.toBe(asset?.symbol);
      expect(isCanonicalAccount(configuration.addressForm, asset?.reference ?? '')).toBe(true);
    });

    it('refuses a currency another family settles', () => {
      const foreign = CONTRACTS.filter(
        (candidate) => candidate.nativeCurrency !== contract.nativeCurrency,
      );

      for (const other of foreign) {
        expect(findAllowedAsset(contract.network, other.nativeCurrency)).toBeNull();
      }
    });

    it('refuses a currency nobody settles', () => {
      expect(findAllowedAsset(contract.network, 'NOTACOIN')).toBeNull();
    });
  });

  describe('naming a transaction', () => {
    it('uses the form its own ecosystem writes', () => {
      expect(configuration.referenceForm).toBe(contract.referenceForm);
      expect(isCanonicalReference(contract.referenceForm, contract.transactionReference)).toBe(
        true,
      );
    });

    /**
     * A hash, an id and a signature are three different things under one field name. Asserting that
     * each family rejects the others is what keeps the field opaque rather than quietly EVM-shaped.
     */
    it('rejects the way another family names one', () => {
      const others = CONTRACTS.filter((candidate) => candidate.family !== contract.family);

      for (const other of others) {
        expect(isCanonicalReference(contract.referenceForm, other.transactionReference)).toBe(
          false,
        );
      }
    });

    it('survives the round trip through canonicalisation unchanged', () => {
      expect(canonicaliseReference(contract.referenceForm, contract.transactionReference)).toBe(
        contract.transactionReference,
      );
    });
  });

  describe('building a payment URI', () => {
    const uriFor = (assetReference: string, decimals: number, memo: string | null): string =>
      buildPaymentUri({
        networkFamily: contract.family,
        evmChainId: configuration.evmChainId,
        destinationAccount: contract.allocate(4).account,
        assetReference,
        assetDecimals: decimals,
        amountInBaseUnits: '25000000',
        memo,
      });

    it.skipIf(!configuration.capabilities.supportsNativePayments)(
      'builds one for a native payment, naming no contract',
      () => {
        const uri = uriFor(NATIVE_ASSET_REFERENCE, 6, null);

        expect(uri.startsWith(contract.uriScheme)).toBe(true);
        expect(uri).not.toContain(NATIVE_ASSET_REFERENCE);
      },
    );

    it.skipIf(!configuration.capabilities.supportsTokenPayments)(
      'builds one for a token payment, naming the asset identity',
      () => {
        const asset = findAllowedAsset(contract.network, contract.tokenCurrency);
        const uri = uriFor(asset?.reference ?? '', asset?.decimals ?? 6, null);

        expect(uri.startsWith(contract.uriScheme)).toBe(true);
        expect(uri).toContain(asset?.reference ?? '');
      },
    );

    it('carries the destination it was given, byte for byte', () => {
      const destination = contract.allocate(4).account;

      expect(uriFor(NATIVE_ASSET_REFERENCE, 6, null)).toContain(destination);
    });

    /**
     * A capability difference, asserted from both sides rather than skipped on one. Solana Pay has a
     * reference field; the other two have nowhere to put one, and a memo silently dropped is a
     * payment nobody can attribute.
     */
    it.skipIf(!configuration.capabilities.supportsMemo)('carries a memo it can express', () => {
      expect(uriFor(NATIVE_ASSET_REFERENCE, 6, 'order-12345')).toContain('order-12345');
    });

    it.skipIf(configuration.capabilities.supportsMemo)(
      'refuses a memo it would have to drop',
      () => {
        expect(() => uriFor(NATIVE_ASSET_REFERENCE, 6, 'order-12345')).toThrow(
          UnsupportedPaymentUriError,
        );
      },
    );
  });

  describe('describing itself to the rest of the system', () => {
    /**
     * The difference that must never be faked. An orchestrator reading `chainId` has to be able to
     * tell "this chain has no numeric identity" from "this chain is number zero".
     */
    it('publishes a numeric chain identity only if it has one', () => {
      expect(configuration.evmChainId).toBe(contract.chainIdentifier);
    });

    it('offers an explorer link for an account and for a transaction', () => {
      const account = contract.allocate(5).account;

      expect(explorerAccountUrl(contract.network, account)).toContain(account);
      expect(explorerTransactionUrl(contract.network, contract.transactionReference)).toContain(
        contract.transactionReference,
      );
    });

    it('declares a confirmation policy it can actually apply', () => {
      expect(configuration.requiredConfirmations).toBeGreaterThan(0);
      // Written as an implication rather than a branch, so the assertion runs on every family and a
      // network that gained a finality gate without the tracking to serve it would fail here.
      const gateIsServiceable =
        !configuration.requiresFinalityTag || configuration.capabilities.supportsFinalityTracking;
      expect(gateIsServiceable).toBe(true);
    });

    /**
     * Settlement is a claim about being able to sign and broadcast, which this system can do on one
     * family and not the other two. Stated per family in the table rather than inferred, so turning
     * it on somewhere nothing can sign is a failing test rather than a stranded payment.
     */
    it('claims settlement only where a broadcaster exists', () => {
      expect(configuration.capabilities.supportsSettlement).toBe(contract.supportsSettlement);
    });
  });
});

/**
 * Properties of the set rather than of any one member. A contract suite that only ever looks at one
 * adapter at a time cannot notice two of them agreeing where they should differ.
 */
describe('the three adapters as a set', () => {
  it('gives each family its own address form', () => {
    const forms = CONTRACTS.map(
      (contract) => networkConfigurationFor(contract.network).addressForm,
    );

    expect(new Set(forms).size).toBe(CONTRACTS.length);
  });

  it('gives each family its own transaction reference form', () => {
    const forms = CONTRACTS.map((contract) => contract.referenceForm);

    expect(new Set(forms).size).toBe(CONTRACTS.length);
  });

  it('issues a different destination on every family for one derivation index', () => {
    const accounts = CONTRACTS.map((contract) => contract.allocate(0).account);

    expect(new Set(accounts).size).toBe(CONTRACTS.length);
  });

  it('gives each family its own URI scheme, so a wallet cannot mistake one for another', () => {
    const schemes = CONTRACTS.map((contract) => contract.uriScheme);

    expect(new Set(schemes).size).toBe(CONTRACTS.length);
  });

  /** Exactly one family has a numeric chain identity, and the contract says so rather than guessing. */
  it('has exactly one family with a numeric chain identity', () => {
    const numbered = CONTRACTS.filter((contract) => contract.chainIdentifier !== null);

    expect(numbered.map((contract) => contract.family)).toEqual(['polygon']);
  });

  it('has exactly one family able to carry a memo', () => {
    const withMemo = CONTRACTS.filter(
      (contract) => networkConfigurationFor(contract.network).capabilities.supportsMemo,
    );

    expect(withMemo.map((contract) => contract.family)).toEqual(['solana']);
  });
});
