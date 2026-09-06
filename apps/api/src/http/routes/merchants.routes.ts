import type { Merchant } from '@cryptopay/shared';

import type { MerchantRepository } from '../../infrastructure/persistence/merchant.repository.js';
import { type AuthenticationHook, requireMerchant } from '../authentication.js';
import { ApplicationError } from '../problem-details.js';
import type { ApplicationServer } from '../server-types.js';

/**
 * Backs the dashboard's session check. Presenting a key and receiving the merchant it belongs to is
 * the whole of authentication in this product: there are no accounts and no passwords, and the
 * dashboard is a client of the same API a merchant's own server uses.
 */

export interface MerchantRouteDependencies {
  readonly merchantRepository: MerchantRepository;
  readonly authenticate: AuthenticationHook;
}

export function registerMerchantRoutes(
  server: ApplicationServer,
  dependencies: MerchantRouteDependencies,
): void {
  server.get(
    '/v1/merchants/me',
    { preHandler: dependencies.authenticate },
    async (request, reply) => {
      const authenticated = requireMerchant(request);
      const merchant = await dependencies.merchantRepository.findById(authenticated.merchantId);

      if (merchant === null) {
        throw new ApplicationError(
          'resource_not_found',
          'The key authenticated but its merchant no longer exists.',
        );
      }

      const body: Merchant = {
        identifier: merchant.id,
        displayName: merchant.name,
        environment: authenticated.environment,
        underpaymentToleranceBasisPoints: merchant.underpaymentToleranceBasisPoints,
        overpaymentToleranceBasisPoints: merchant.overpaymentToleranceBasisPoints,
        defaultPaymentLifetimeSeconds: merchant.defaultPaymentLifetimeSeconds,
      };

      await reply.code(200).send(body);
    },
  );
}
