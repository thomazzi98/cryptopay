import type { Environment, NetworkIdentifier } from '@cryptopay/shared';

import type {
  SettlementTickOutcome,
  SettlePaymentsUseCase,
} from '../application/settle-payments.use-case.js';
import type { SettlementBroadcaster } from '../application/ports/settlement-broadcaster.port.js';
import type {
  Lease,
  LeaderLeaseRepository,
} from '../infrastructure/persistence/leader-lease.repository.js';
import type { StructuredLogger } from '../observability/logger.js';

/**
 * The process that moves money out.
 *
 * It holds its own lease rather than sharing the scanner's, under a different name, so exactly one
 * settler runs per network and it is not the same process that scans. That separation is the point:
 * this is the only worker that can sign, so it is the one that runs with its own database role, its
 * own container and the narrowest access in the deployment.
 *
 * A settler that hangs must stop being the settler. The lease expires on its own schedule whether or
 * not the holder noticed, and every claim of a sequence number reconciles against the chain, so a
 * worker that wakes up after its lease has passed to a peer cannot sign into a slot the peer has
 * already used: the database refuses the row.
 *
 * Ticks are slow by design. Settlement has no deadline a customer can feel — the payment they made
 * was already confirmed and reported — so polling it every few seconds would spend RPC quota to
 * discover nothing. The interval is measured in tens of seconds.
 */

export interface SettlementWorkerOptions {
  readonly leaseSeconds: number;
  readonly pollIntervalMilliseconds: number;
  readonly errorBackoffMilliseconds: number;
}

export interface SettlementWorkerDependencies {
  readonly networkIdentifier: NetworkIdentifier;
  readonly environment: Environment;
  readonly broadcaster: SettlementBroadcaster;
  readonly settler: SettlePaymentsUseCase;
  readonly leaseRepository: LeaderLeaseRepository;
  readonly logger: StructuredLogger;
  readonly holderIdentity: string;
  readonly options: SettlementWorkerOptions;
}

export type SettlementTick =
  | { readonly kind: 'not_leader' }
  | { readonly kind: 'worked'; readonly outcome: SettlementTickOutcome; readonly retried: number };

export class SettlementWorker {
  private readonly dependencies: SettlementWorkerDependencies;
  private readonly leaseName: string;
  private lease: Lease | null = null;
  private running = false;
  private wakeUp: (() => void) | null = null;

  constructor(dependencies: SettlementWorkerDependencies) {
    this.dependencies = dependencies;
    this.leaseName = `settlement:${dependencies.networkIdentifier}`;
  }

  /**
   * Refuses to start against an endpoint that is not the configured chain.
   *
   * The scanner makes the same check, and it is made again here rather than trusted from there. A
   * signature is valid on every EVM chain at once, so this process has more to lose from a wrong
   * endpoint than any other, and the check costs one call at startup.
   */
  async prepare(): Promise<void> {
    await this.dependencies.broadcaster.assertLedgerIdentity();
    await this.dependencies.settler.reportTreasury(this.dependencies.environment);
    this.dependencies.logger.info(
      {
        event: 'settlement.ready',
        network: this.dependencies.networkIdentifier,
        treasuryAccount: this.dependencies.broadcaster.treasuryAccount,
      },
      'The settlement worker verified the chain it is signing for',
    );
  }

  async runOnce(): Promise<SettlementTick> {
    const lease = await this.holdLease();
    if (lease === null) {
      return { kind: 'not_leader' };
    }

    const retried = await this.dependencies.settler.retryFailed();
    const outcome = await this.dependencies.settler.execute();
    await this.dependencies.settler.reportTreasury(this.dependencies.environment);
    this.report(outcome, retried);
    return { kind: 'worked', outcome, retried };
  }

  async start(): Promise<void> {
    this.running = true;
    for (;;) {
      const delay = await this.tickAndChooseDelay();
      await this.sleep(delay);
      // Checked after the sleep, so a shutdown arriving mid-sleep ends the loop rather than paying
      // for one more tick against a network nobody is waiting on.
      if (!this.shouldKeepRunning()) {
        return;
      }
    }
  }

  private shouldKeepRunning(): boolean {
    return this.running;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wakeUp?.();
    const lease = this.lease;
    this.lease = null;
    if (lease !== null) {
      await this.dependencies.leaseRepository.release(lease);
    }
  }

  private async tickAndChooseDelay(): Promise<number> {
    try {
      const tick = await this.runOnce();
      // Work produced more work: something was broadcast and its receipt is worth asking about
      // sooner than the idle interval.
      if (tick.kind === 'worked' && tick.outcome.broadcast > 0) {
        return Math.min(this.dependencies.options.pollIntervalMilliseconds, 5000);
      }
      return this.dependencies.options.pollIntervalMilliseconds;
    } catch (error) {
      this.dependencies.logger.error(
        { error, network: this.dependencies.networkIdentifier },
        'The settlement tick failed',
      );
      return this.dependencies.options.errorBackoffMilliseconds;
    }
  }

  private async holdLease(): Promise<Lease | null> {
    const held = this.lease;
    if (held !== null) {
      const renewed = await this.dependencies.leaseRepository.renew(
        held,
        this.dependencies.options.leaseSeconds,
      );
      this.lease = renewed;
      return renewed;
    }

    const acquired = await this.dependencies.leaseRepository.acquire(
      this.leaseName,
      this.dependencies.holderIdentity,
      this.dependencies.options.leaseSeconds,
    );
    this.lease = acquired;
    if (acquired !== null) {
      this.dependencies.logger.info(
        {
          event: 'settlement.lease_taken',
          network: this.dependencies.networkIdentifier,
          fencingToken: acquired.fencingToken.toString(),
        },
        'The settlement worker took the lease',
      );
    }
    return acquired;
  }

  private report(outcome: SettlementTickOutcome, retried: number): void {
    const nothingHappened =
      outcome.reconciled === 0 &&
      outcome.planned === 0 &&
      outcome.broadcast === 0 &&
      outcome.settled === 0 &&
      outcome.failed === 0 &&
      retried === 0;
    if (nothingHappened) {
      return;
    }

    this.dependencies.logger.info(
      {
        event: 'settlement.tick',
        network: this.dependencies.networkIdentifier,
        ...outcome,
        retried,
      },
      'Settlement advanced',
    );

    // Not an error on its own, and not silent either: money is sitting in addresses this system
    // controls with nowhere configured to send it, and only an operator can fix that.
    if (outcome.awaitingPayoutDestination > 0) {
      this.dependencies.logger.warn(
        {
          event: 'settlement.awaiting_payout_destination',
          network: this.dependencies.networkIdentifier,
          count: outcome.awaitingPayoutDestination,
        },
        'Payments are settled on chain but no payout destination is configured for their merchant',
      );
    }
  }

  private sleep(milliseconds: number): Promise<void> {
    if (milliseconds === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakeUp = null;
        resolve();
      }, milliseconds);
      this.wakeUp = () => {
        clearTimeout(timer);
        this.wakeUp = null;
        resolve();
      };
    });
  }
}
