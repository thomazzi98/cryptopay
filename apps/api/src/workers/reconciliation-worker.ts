import type { NetworkIdentifier } from '@cryptopay/shared';

import type { ReconcilePaymentsUseCase } from '../application/reconcile-payments.use-case.js';
import type { LeaderLeaseRepository } from '../infrastructure/persistence/leader-lease.repository.js';
import type { StructuredLogger } from '../observability/logger.js';

/**
 * The process that compares this system's belief about a network against the network itself.
 *
 * Its own lease, separate from the scanner's, so a network whose scanner has halted is still
 * reconciled. That is deliberate and is most of the value: a halted scanner is exactly the situation
 * where the database and the chain drift apart, and a reconciler that stopped alongside it would go
 * quiet at the moment it became useful.
 *
 * It runs far less often than the scanner because it is a safety net rather than a detector. Every
 * tick costs a balance read per destination, and a reconciler that outpaced the endpoint's rate
 * limit would cause the outage it exists to notice.
 */

interface ReconciliationWorkerOptions {
  readonly leaseSeconds: number;
  readonly pollIntervalMilliseconds: number;
  readonly errorBackoffMilliseconds: number;
}

export interface ReconciliationWorkerDependencies {
  readonly network: NetworkIdentifier;
  readonly reconciler: ReconcilePaymentsUseCase;
  readonly leaseRepository: LeaderLeaseRepository;
  readonly holderIdentity: string;
  readonly logger: StructuredLogger;
  readonly options: ReconciliationWorkerOptions;
}

export class ReconciliationWorker {
  private readonly dependencies: ReconciliationWorkerDependencies;
  private running = false;
  private stopped: Promise<void> = Promise.resolve();

  constructor(dependencies: ReconciliationWorkerDependencies) {
    this.dependencies = dependencies;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.stopped = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.stopped;
  }

  private get resourceName(): string {
    return `reconciler:${this.dependencies.network}`;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const waited = await this.tick();
      await this.pause(waited);
    }
  }

  /** Returns how long to wait before the next attempt, so a failing endpoint is not hammered. */
  private async tick(): Promise<number> {
    const { leaseRepository, holderIdentity, options, logger } = this.dependencies;
    try {
      const lease = await leaseRepository.acquire(
        this.resourceName,
        holderIdentity,
        options.leaseSeconds,
      );
      // Another instance holds it. Reconciliation is idempotent, but one reader per network is
      // enough and a second would only spend the endpoint's rate limit.
      if (lease === null) {
        return options.pollIntervalMilliseconds;
      }

      const outcome = await this.dependencies.reconciler.execute();
      // Logged at info only when it found something. A safety net that says "nothing wrong" every
      // minute trains everybody to stop reading it.
      const foundSomething = outcome.orphanedTransfers > 0 || outcome.discrepancies > 0;
      if (foundSomething) {
        logger.warn(
          {
            event: 'reconciliation.discrepancy_found',
            network: this.dependencies.network,
            ...outcome,
          },
          'reconciliation found a disagreement between this system and the chain',
        );
      }
      return options.pollIntervalMilliseconds;
    } catch (error) {
      logger.error(
        { event: 'reconciliation.tick_failed', network: this.dependencies.network, error },
        'a reconciliation pass failed',
      );
      return options.errorBackoffMilliseconds;
    }
  }

  private pause(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
