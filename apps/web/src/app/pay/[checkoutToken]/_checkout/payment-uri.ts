/**
 * The EIP-681 request a wallet scanner understands.
 *
 * The token transfer form is used rather than the plain value form: the payment is an ERC-20
 * movement, so the target of the URI is the token contract and the recipient travels as the first
 * argument. Addresses stay lowercase, as they are everywhere else in this system, and the amount
 * stays the base-unit decimal string that came off the wire so nothing here can round it.
 */
export function buildTokenTransferUri(input: {
  readonly tokenAddress: string;
  readonly chainIdentifier: number;
  readonly recipient: string;
  readonly amountInBaseUnits: string;
}): string {
  const chain = input.chainIdentifier.toString();
  const query = `address=${input.recipient}&uint256=${input.amountInBaseUnits}`;
  return `ethereum:${input.tokenAddress}@${chain}/transfer?${query}`;
}
