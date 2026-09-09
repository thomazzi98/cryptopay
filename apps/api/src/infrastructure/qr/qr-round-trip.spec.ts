import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import { describe, expect, it } from 'vitest';

import { buildPaymentUri } from '@cryptopay/shared';

import { scanPaymentQrCode } from './qr-decoder.test-helper.js';

/**
 * Every payment URI this system can produce must survive being drawn and read back.
 *
 * The fixed examples elsewhere prove the builders agree with themselves on six known inputs. They
 * cannot show whether readability depends on the content, and it might: a destination and a mint are
 * random, so every payment carries a different payload, and a symbol that happens to be a version or
 * a mask the decoder handles badly would fail for some customers and not others. That is exactly the
 * shape of a defect nobody reproduces.
 */

// Enough payloads to catch a content-dependent encoding fault, few enough that trying six module
// sizes for each stays quick. The decoder, not the encoder, is what makes several sizes necessary;
// `scanPaymentQrCode` records the measurements behind that.
const SAMPLES = 40;

function solanaAccount(): string {
  return base58.encode(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
}

describe('a payment QR, over many different payloads', () => {
  it('reads back byte for byte on every Solana token payment it draws', () => {
    const failures: string[] = [];

    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const uri = buildPaymentUri({
        networkFamily: 'solana',
        evmChainId: null,
        destinationAccount: solanaAccount(),
        assetReference: solanaAccount(),
        assetDecimals: 6,
        amountInBaseUnits: '25000000',
        memo: null,
      });
      const decoded = scanPaymentQrCode(uri);
      if (decoded !== uri) {
        failures.push(`${uri} decoded as ${String(decoded)}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('reads back byte for byte on every Solana native payment it draws', () => {
    const failures: string[] = [];

    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const uri = buildPaymentUri({
        networkFamily: 'solana',
        evmChainId: null,
        destinationAccount: solanaAccount(),
        assetReference: 'native',
        assetDecimals: 9,
        amountInBaseUnits: '2500000000',
        memo: null,
      });
      const decoded = scanPaymentQrCode(uri);
      if (decoded !== uri) {
        failures.push(`${uri} decoded as ${String(decoded)}`);
      }
    }

    expect(failures).toEqual([]);
  });
});
