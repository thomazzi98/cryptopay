import { signWebhook } from '@cryptopay/shared/server';

import {
  classifyResponseStatus,
  decideRetry,
  type AttemptOutcome,
  type RetryPolicy,
} from '../domain/webhook-retry.js';
import type { CallbackTransport } from '../infrastructure/callbacks/callback-transport.js';
import {
  decideDestination,
  type AddressResolver,
  type DestinationDecision,
} from '../infrastructure/callbacks/destination-policy.js';
import type {
  WebhookDelivery,
  WebhookDeliveryRepository,
} from '../infrastructure/persistence/webhook-delivery.repository.js';
import type { WebhookSecretRepository } from '../infrastructure/persistence/webhook-secret.repository.js';

/**
 * Draining the callback outbox.
 *
 * Three things happen per attempt and the order matters. The destination is decided first, so a
 * refused address is never even signed for. The timestamp is regenerated, because a per-event
 * timestamp makes every retry past the tolerance window fail verification on the merchant's side.
 * The stored body is transmitted byte for byte, because the signature covers exactly those bytes and
 * re-serializing reorders keys.
 */

export interface DeliveryOutcome {
  readonly claimed: number;
  readonly delivered: number;
  readonly retrying: number;
  readonly abandoned: number;
  readonly blocked: number;
}

export interface DeliverCallbacksDependencies {
  readonly webhookDeliveryRepository: WebhookDeliveryRepository;
  readonly webhookSecretRepository: WebhookSecretRepository;
  readonly transport: CallbackTransport;
  readonly resolveAddresses: AddressResolver;
  readonly retryPolicy: RetryPolicy;
  readonly privateDestinationAllowlist: readonly string[];
  /**
   * Whether the deployment permits the private allowlist at all. Held by operations; the merchant's
   * choice of environment is the second, independent condition, and both must hold.
   */
  readonly allowlistIsPermittedByDeployment: boolean;
  readonly workerIdentity: string;
  readonly now: () => Date;
  readonly randomFraction: () => number;
  readonly requestTimeoutMilliseconds?: number;
  readonly batchSize?: number;
  readonly claimLeaseSeconds?: number;
}

const DEFAULT_TIMEOUT_MILLISECONDS = 10_000;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_CLAIM_LEASE_SECONDS = 60;
const JITTER_SPREAD = 0.4;
const JITTER_FLOOR = 0.8;

export class DeliverCallbacksUseCase {
  private readonly dependencies: DeliverCallbacksDependencies;

  constructor(dependencies: DeliverCallbacksDependencies) {
    this.dependencies = dependencies;
  }

  async execute(): Promise<DeliveryOutcome> {
    await this.dependencies.webhookDeliveryRepository.releaseExpiredClaims();

    const claimed = await this.dependencies.webhookDeliveryRepository.claimDue(
      this.dependencies.workerIdentity,
      this.dependencies.batchSize ?? DEFAULT_BATCH_SIZE,
      this.dependencies.claimLeaseSeconds ?? DEFAULT_CLAIM_LEASE_SECONDS,
    );

    let delivered = 0;
    let retrying = 0;
    let abandoned = 0;
    let blocked = 0;

    for (const delivery of claimed) {
      const result = await this.deliverOne(delivery);
      delivered += result === 'delivered' ? 1 : 0;
      retrying += result === 'retry' ? 1 : 0;
      abandoned += result === 'abandoned' ? 1 : 0;
      blocked += result === 'blocked' ? 1 : 0;
    }

    return { claimed: claimed.length, delivered, retrying, abandoned, blocked };
  }

  private async deliverOne(
    delivery: WebhookDelivery,
  ): Promise<'delivered' | 'retry' | 'abandoned' | 'blocked'> {
    // Two different numbers, deliberately. The attempt number is the position in this event's whole
    // history and never repeats, so no attempt row is ever silently dropped. The schedule position
    // restarts with each redelivery, so asking for one gives the event the full schedule again.
    const attemptNumber = delivery.attemptCount + 1;
    const destination = await this.decideDestinationFor(delivery);

    if (!destination.allowed || destination.pinnedAddress === null) {
      await this.dependencies.webhookDeliveryRepository.completeAttempt(
        {
          deliveryId: delivery.identifier,
          attemptNumber,
          outcome: 'blocked',
          responseStatus: null,
          resolvedAddress: null,
          responseSnippet: null,
          durationMilliseconds: 0,
          failureReason: destination.reason,
          usedPrivateAllowlist: false,
        },
        { kind: 'abandoned', reason: destination.reason },
      );
      return 'blocked';
    }

    const secrets = await this.dependencies.webhookSecretRepository.activeSecrets(
      delivery.merchantId,
      delivery.environment,
    );
    if (secrets.length === 0) {
      // Retried rather than abandoned, unlike a refused destination. A refused destination will be
      // refused again; a missing secret is an operator-side condition that is fixed in seconds, and
      // abandoning would throw the event away for a cause that no longer exists by the next attempt.
      // The ordinary schedule still ends it, so this cannot retry forever.
      return this.rescheduleWithoutSending(
        delivery,
        attemptNumber,
        destination,
        'the merchant has no active signing secret',
      );
    }

    const sentAt = this.dependencies.now();
    const headers = signWebhook({
      identifier: delivery.identifier,
      // Regenerated on every attempt. Reusing the event's original timestamp makes every retry past
      // the tolerance window fail verification, so a merchant who was briefly down is never told.
      timestamp: Math.floor(sentAt.getTime() / 1000),
      body: delivery.payload,
      secrets: secrets.map((entry) => entry.secret),
    });

    const response = await this.dependencies.transport({
      url: delivery.destinationUrl,
      pinnedAddress: destination.pinnedAddress,
      addressFamily: destination.addressFamily ?? 4,
      headers: {
        ...headers,
        'user-agent': 'CryptoPay-Webhooks/1.0',
        'cryptopay-event-type': delivery.eventType,
        'cryptopay-environment': delivery.environment,
      },
      body: delivery.payload,
      timeoutMilliseconds:
        this.dependencies.requestTimeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS,
    });

    const outcome: AttemptOutcome = outcomeFor(response.status, response.timedOut);
    const decision = decideRetry({
      policy: this.dependencies.retryPolicy,
      outcome,
      attemptNumber: schedulePositionOf(delivery),
      responseStatus: response.status,
      retryAfterSeconds: response.retryAfterSeconds,
      ageInSeconds: ageInSeconds(delivery.cycleStartedAt, sentAt),
      jitterFactor: JITTER_FLOOR + this.dependencies.randomFraction() * JITTER_SPREAD,
    });

    const attempt = {
      deliveryId: delivery.identifier,
      attemptNumber,
      outcome,
      responseStatus: response.status,
      resolvedAddress: destination.pinnedAddress,
      responseSnippet: response.snippet,
      durationMilliseconds: response.durationMilliseconds,
      failureReason: response.failureReason ?? (outcome === 'delivered' ? null : decision.reason),
      usedPrivateAllowlist: destination.usedPrivateAllowlist,
    };

    if (outcome === 'delivered') {
      await this.dependencies.webhookDeliveryRepository.completeAttempt(attempt, {
        kind: 'delivered',
        at: sentAt,
      });
      return 'delivered';
    }

    if (decision.kind === 'abandon') {
      await this.dependencies.webhookDeliveryRepository.completeAttempt(attempt, {
        kind: 'abandoned',
        reason: decision.reason,
      });
      return 'abandoned';
    }

    await this.dependencies.webhookDeliveryRepository.completeAttempt(attempt, {
      kind: 'retry',
      at: new Date(sentAt.getTime() + decision.delayInSeconds * 1000),
      reason: describeFailure(response.status, response.failureReason),
    });
    return 'retry';
  }

  /**
   * Records an attempt that never left the process and puts the delivery back on the schedule.
   *
   * The attempt row is written either way, so the reason a merchant received nothing is visible in
   * the delivery log rather than only in a server log they cannot read.
   */
  private async rescheduleWithoutSending(
    delivery: WebhookDelivery,
    attemptNumber: number,
    destination: DestinationDecision,
    reason: string,
  ): Promise<'retry' | 'abandoned'> {
    const now = this.dependencies.now();
    const decision = decideRetry({
      policy: this.dependencies.retryPolicy,
      outcome: 'retryable',
      attemptNumber: schedulePositionOf(delivery),
      responseStatus: null,
      retryAfterSeconds: null,
      ageInSeconds: ageInSeconds(delivery.cycleStartedAt, now),
      jitterFactor: JITTER_FLOOR + this.dependencies.randomFraction() * JITTER_SPREAD,
    });

    const attempt = {
      deliveryId: delivery.identifier,
      attemptNumber,
      outcome: 'retryable' as const,
      responseStatus: null,
      resolvedAddress: destination.pinnedAddress,
      responseSnippet: null,
      durationMilliseconds: 0,
      failureReason: reason,
      usedPrivateAllowlist: destination.usedPrivateAllowlist,
    };

    if (decision.kind === 'abandon') {
      await this.dependencies.webhookDeliveryRepository.completeAttempt(attempt, {
        kind: 'abandoned',
        reason,
      });
      return 'abandoned';
    }

    await this.dependencies.webhookDeliveryRepository.completeAttempt(attempt, {
      kind: 'retry',
      at: new Date(now.getTime() + decision.delayInSeconds * 1000),
      reason,
    });
    return 'retry';
  }

  /**
   * The allowlist needs two independent conditions, held by different people: the deployment must
   * permit it (operations) and the payment must be in the test environment (the merchant's choice of
   * API key). Either one alone closes it.
   */
  private decideDestinationFor(delivery: WebhookDelivery): Promise<DestinationDecision> {
    return decideDestination(delivery.destinationUrl, this.dependencies.resolveAddresses, {
      privateDestinationAllowlist: this.dependencies.privateDestinationAllowlist,
      allowlistIsPermitted:
        this.dependencies.allowlistIsPermittedByDeployment && delivery.environment === 'test',
    });
  }
}

/** Where this attempt sits in the current schedule, which a redelivery restarts. */
function schedulePositionOf(delivery: WebhookDelivery): number {
  return delivery.attemptCount - delivery.scheduleOffset + 1;
}

function ageInSeconds(createdAt: Date, now: Date): number {
  const elapsed = Math.round((now.getTime() - createdAt.getTime()) / 1000);
  return Math.max(elapsed, 0);
}

function outcomeFor(status: number | null, timedOut: boolean): AttemptOutcome {
  if (status === null) {
    return timedOut ? 'timeout' : 'retryable';
  }
  return classifyResponseStatus(status);
}

function describeFailure(status: number | null, failureReason: string | null): string {
  if (status !== null) {
    return `the destination answered ${status.toString()}`;
  }
  return failureReason ?? 'the request failed';
}
