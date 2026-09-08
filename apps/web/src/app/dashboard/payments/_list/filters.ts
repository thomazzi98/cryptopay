import {
  NETWORK_IDENTIFIERS,
  isNetworkIdentifier,
  isPaymentStatus,
  type NetworkIdentifier,
  type PaymentStatus,
} from '@cryptopay/shared';

/**
 * The filter state, and its one true home: the URL.
 *
 * A filtered view is a link. Keeping the state in the query string is what makes it sendable to a
 * colleague and what makes a reload land on the same list, and it is why nothing here is stored in
 * component state that a navigation could drop.
 */

export interface PaymentFilters {
  readonly status: PaymentStatus | null;
  readonly network: NetworkIdentifier | null;
  readonly merchantReference: string;
}

/** Display names for the networks the API can return. Never used to identify one. */
const NETWORK_LABELS: Readonly<Record<NetworkIdentifier, string>> = Object.freeze({
  'polygon-mainnet': 'Polygon',
  'polygon-amoy': 'Polygon Amoy',
  'local-anvil': 'Local Anvil',
  'tron-mainnet': 'TRON',
  'tron-nile': 'TRON Nile',
});

export const SELECTABLE_NETWORKS: readonly NetworkIdentifier[] = NETWORK_IDENTIFIERS;

export function describeNetwork(network: string): string {
  if (isNetworkIdentifier(network)) {
    return NETWORK_LABELS[network];
  }
  return network;
}

export function readFilters(source: { get(name: string): string | null }): PaymentFilters {
  const status = source.get('status');
  const network = source.get('network');
  const merchantReference = source.get('merchantReference');

  return {
    status: status !== null && isPaymentStatus(status) ? status : null,
    network: network !== null && isNetworkIdentifier(network) ? network : null,
    merchantReference: merchantReference ?? '',
  };
}

export function writeFilters(filters: PaymentFilters): string {
  const parameters = new URLSearchParams();
  if (filters.status !== null) {
    parameters.set('status', filters.status);
  }
  if (filters.network !== null) {
    parameters.set('network', filters.network);
  }
  if (filters.merchantReference !== '') {
    parameters.set('merchantReference', filters.merchantReference);
  }
  return parameters.toString();
}

export function hasActiveFilter(filters: PaymentFilters): boolean {
  return filters.status !== null || filters.network !== null || filters.merchantReference !== '';
}

/** The query the list endpoint actually accepts, built from ListPaymentsQuerySchema's fields. */
export function buildListPath(filters: PaymentFilters, cursor: string | null, limit: number) {
  const parameters = new URLSearchParams(writeFilters(filters));
  parameters.set('limit', limit.toString());
  if (cursor !== null) {
    parameters.set('startingAfter', cursor);
  }
  return `v1/payments?${parameters.toString()}`;
}
