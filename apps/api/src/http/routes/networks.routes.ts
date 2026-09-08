import type { NetworkDescriptor, NetworkList } from '@cryptopay/shared';

import type { Configuration } from '../../configuration.js';
import { walletRpcUrlFor } from '../../configuration.js';
import {
  networksForEnvironment,
  type NetworkConfiguration,
} from '../../infrastructure/chain/network-configuration.js';
import type { BlockCursorRepository } from '../../infrastructure/persistence/block-cursor.repository.js';
import { requireMerchant, type AuthenticationHook } from '../authentication.js';
import type { ApplicationServer } from '../server-types.js';

/**
 * What this deployment can accept, as data.
 *
 * An integrator that hardcodes a chain identifier, a token address or a confirmation count has to
 * ship a release whenever any of them changes, and the moment they get one wrong is the moment money
 * goes to the wrong contract. Reading them from here means adding a network stays what it is meant
 * to be: one frozen configuration entry plus RPC endpoints, with nothing to change on their side.
 *
 * A network with no cursor is omitted rather than listed as unavailable. It is exactly the set that
 * payment creation accepts, and the list is what an integrator builds their own network menu from.
 */

export interface NetworkRouteDependencies {
  readonly authenticate: AuthenticationHook;
  readonly configuration: Configuration;
  readonly blockCursorRepository: BlockCursorRepository;
}

function describe(configuration: Configuration, network: NetworkConfiguration): NetworkDescriptor {
  return {
    network: network.networkIdentifier,
    chainIdentifier: network.evmChainId,
    networkFamily: network.networkFamily,
    ledgerIdentity: network.ledgerIdentity,
    addressForm: network.addressForm,
    capabilities: network.capabilities,
    displayName: network.displayName,
    environment: network.environment,
    nativeCurrency: network.nativeCurrency,
    requiredConfirmations: network.requiredConfirmations,
    requiresFinalityTag: network.requiresFinalityTag,
    assets: network.assetAllowlist.map((asset) => ({
      reference: asset.reference,
      symbol: asset.symbol,
      decimals: asset.decimals,
    })),
    explorerBaseUrl: network.explorerBaseUrl,
    walletRpcUrl: walletRpcUrlFor(configuration, network.networkIdentifier),
  };
}

export function registerNetworkRoutes(
  server: ApplicationServer,
  dependencies: NetworkRouteDependencies,
): void {
  server.get('/v1/networks', { preHandler: dependencies.authenticate }, async (request, reply) => {
    const authenticated = requireMerchant(request);
    const cursors = await dependencies.blockCursorRepository.findAll();
    const watched = new Set(cursors.map((cursor) => cursor.networkIdentifier));

    const body: NetworkList = {
      data: networksForEnvironment(authenticated.environment)
        .filter((network) => watched.has(network.networkIdentifier))
        .map((network) => describe(dependencies.configuration, network)),
    };
    await reply.code(200).send(body);
  });
}
