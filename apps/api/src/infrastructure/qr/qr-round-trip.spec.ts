import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import { describe, expect, it } from 'vitest';

import { buildPaymentUri } from '@cryptopay/shared';

import { renderPaymentQrCode } from './qr-code.js';
import { decodeQrCode } from './qr-decoder.test-helper.js';

/**
 * Every payment URI this system can produce must survive being drawn and read back.
 *
 * The fixed examples elsewhere prove the builders agree with themselves on six known inputs. They
 * cannot show whether readability depends on the content, and it might: a destination and a mint are
 * random, so every payment carries a different payload, and a symbol that happens to be a version or
 * a mask the decoder handles badly would fail for some customers and not others. That is exactly the
 * shape of a defect nobody reproduces.
 */

const SAMPLES = 200;

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
      const decoded = decodeQrCode(renderPaymentQrCode(uri).bytes);
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
      const decoded = decodeQrCode(renderPaymentQrCode(uri).bytes);
      if (decoded !== uri) {
        failures.push(`${uri} decoded as ${String(decoded)}`);
      }
    }

    expect(failures).toEqual([]);
  });
});
