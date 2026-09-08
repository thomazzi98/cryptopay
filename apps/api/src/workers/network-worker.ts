import type { NetworkIdentifier } from '@cryptopay/shared';

import type {
  EvaluatePaymentsUseCase,
  EvaluationOutcome,
} from '../application/evaluate-payments.use-case.js';
import type { ScanNetworkUseCase, ScanOutcome } from '../application/scan-network.use-case.js';
import type { ChainGateway } from '../application/ports/chain-gateway.port.js';
import type { BlockCursorRepository } from '../infrastructure/persistence/block-cursor.repository.js';
import type {
  Lease,
  LeaderLeaseRepository,
} from '../infrastructure/persistence/leader-lease.repository.js';
import type { StructuredLogger } from '../observability/logger.js';

/**
 * The process that keeps one network scanned and its payments evaluated.
 *
 * Both halves run under one lease and in one order: observe first, decide second. Nothing is ever
 * credited on the strength of an evaluation that ran against a window the scanner had not committed.
 *
 * Evaluation does not actually need the lease. Its safety comes from claiming with SKIP LOCKED and
 * from the compare-and-swap on every payment, both of which hold with any number of workers, and a
 * test drives two evaluators concurrently to show it. Running it under the lease anyway keeps one
 * process asking the chain how far it has advanced rather than all of them.
 *
 * Exactly one instance does the work at a time, decided by a lease rather than by a session advisory
 * lock. An advisory lock has no failover when a process hangs but stays connected: scanning silently
 * stops while readiness stays green, which is the worst shape a failure can take in a payment system.
 * A lease expires whether or not the holder noticed it was stuck.
 *
 * The lease's fencing token travels into every write. A worker that hung past its expiry and woke up
 * afterwards still believes it is the leader; its writes are rejected by the token comparison rather
 * than by its own opinion of whether it is still in charge.
 */

export interface NetworkWorkerOptions {
  readonly leaseSeconds: number;
  readonly pollIntervalMilliseconds: number;
  /** Backoff after a tick that threw, so a failing endpoint is not hammered. */
  readonly errorBackoffMilliseconds: number;
  /** Where scanning starts when a network has never been watched before. */
  readonly initialScanRange: number;
}

const DEFAULT_WORKER_OPTIONS: NetworkWorkerOptions = Object.freeze({
  leaseSeconds: 30,
  pollIntervalMilliseconds: 4000,
  errorBackoffMilliseconds: 10_000,
  initialScanRange: 20,
});

export interface NetworkWorkerDependencies {
  readonly gateway: ChainGateway;
  readonly scanner: ScanNetworkUseCase;
  readonly evaluator: EvaluatePaymentsUseCase;
  readonly leaseRepository: LeaderLeaseRepository;
  readonly blockCursorRepository: BlockCursorRepository;
  readonly logger: StructuredLogger;
  readonly holderIdentity: string;
  readonly options?: NetworkWorkerOptions;
}

export type TickOutcome =
  | { readonly kind: 'not_leader' }
  | {
      readonly kind: 'worked';
      readonly scan: ScanOutcome;
      readonly evaluation: EvaluationOutcome | null;
    };

export class NetworkWorker {
  private readonly dependencies: NetworkWorkerDependencies;
  private readonly options: NetworkWorkerOptions;
  private readonly network: NetworkIdentifier;
  private readonly leaseName: string;
  private lease: Lease | null = null;
  private running = false;
  private wakeUp: (() => void) | null = null;

  constructor(dependencies: NetworkWorkerDependencies) {
    this.dependencies = dependencies;
    this.options = dependencies.options ?? DEFAULT_WORKER_OPTIONS;
    this.network = dependencies.gateway.networkIdentifier;
    this.leaseName = `scanner:${this.network}`;
  }

  /**
   * Confirms the endpoint is the chain it claims to be, and places the cursor if this network has
   * never been watched. Starting at the tip rather than at genesis is deliberate: a payment cannot be
   * created on a network with no cursor, so there is no earlier history that could contain money owed
   * to anyone.
   */
  async prepare(): Promise<void> {
    await this.dependencies.gateway.assertLedgerIdentity();
    const progress = await this.dependencies.gateway.readChainProgress();
    await this.dependencies.blockCursorRepository.initialiseIfAbsent(
      this.network,
      progress.tip.height,
      progress.tip.reference,
      this.options.initialScanRange,
    );
  }

  /**
   * One complete tick: hold the lease, stamp its token on the cursor, scan.
   *
   * Returning `not_leader` is the normal outcome for every instance but one, and is not an error.
   */
  async runOnce(): Promise<TickOutcome> {
    const lease = await this.holdLease();
    if (lease === null) {
      return { kind: 'not_leader' };
    }

    const adopted = await this.dependencies.blockCursorRepository.adoptLease(
      this.network,
      lease.fencingToken,
    );
    if (!adopted) {
      // A higher token is already on the cursor: another worker overtook this one between acquiring
      // the lease and stamping it. Stopping now is cheaper than discovering it write by write.
      this.lease = null;
      return { kind: 'not_leader' };
    }

    const scan = await this.dependencies.scanner.execute(lease.fencingToken);
    this.reportScan(scan);
    if (scan.kind === 'lease_lost') {
      this.lease = null;
      return { kind: 'worked', scan, evaluation: null };
    }
    // A halted network is halted for both halves. Evaluating against observations that may sit on a
    // fork nobody could resolve is exactly the guess the halt exists to prevent.
    if (scan.kind === 'halted') {
      return { kind: 'worked', scan, evaluation: null };
    }
    // The window was thrown away because it read back inconsistently. Evaluating now would judge
    // payments against observations the scanner has just refused to trust.
    if (scan.kind === 'discarded') {
      return { kind: 'worked', scan, evaluation: null };
    }

    const evaluation = await this.dependencies.evaluator.execute();
    this.reportEvaluation(evaluation);
    return { kind: 'worked', scan, evaluation };
  }

  async start(): Promise<void> {
    this.running = true;
    for (;;) {
      const delay = await this.tickAndChooseDelay();
      await this.sleep(delay);
      // Checked after the sleep rather than before the tick, so a shutdown that arrives mid-sleep
      // ends the loop without spending one more tick on a network nobody is waiting for.
      if (!this.shouldKeepRunning()) {
        return;
      }
    }
  }

  /** Ends the loop and hands the lease back, so a peer takes over at once rather than after expiry. */
  async stop(): Promise<void> {
    this.running = false;
    this.wakeUp?.();
    const lease = this.lease;
    this.lease = null;
    if (lease !== null) {
      await this.dependencies.leaseRepository.release(lease);
    }
  }

  private shouldKeepRunning(): boolean {
    return this.running;
  }

  private async tickAndChooseDelay(): Promise<number> {
    try {
      const tick = await this.runOnce();
      if (tick.kind === 'worked' && tick.scan.kind === 'scanned') {
        // More blocks are already waiting, so there is nothing to wait for.
        return 0;
      }
      return this.options.pollIntervalMilliseconds;
    } catch (error) {
      this.dependencies.logger.error({ error, network: this.network }, 'The network tick failed');
      return this.options.errorBackoffMilliseconds;
    }
  }

  private async holdLease(): Promise<Lease | null> {
    const held = this.lease;
    if (held !== null) {
      const renewed = await this.dependencies.leaseRepository.renew(
        held,
        this.options.leaseSeconds,
      );
      this.lease = renewed;
      return renewed;
    }
    const acquired = await this.dependencies.leaseRepository.acquire(
      this.leaseName,
      this.dependencies.holderIdentity,
      this.options.leaseSeconds,
    );
    this.lease = acquired;
    if (acquired !== null) {
      this.dependencies.logger.info(
        { network: this.network, fencingToken: acquired.fencingToken.toString() },
        'The network worker took the lease',
      );
    }
    return acquired;
  }

  private reportEvaluation(evaluation: EvaluationOutcome): void {
    if (evaluation.transitioned === 0) {
      return;
    }
    this.dependencies.logger.info(
      {
        network: this.network,
        transitioned: evaluation.transitioned,
        contended: evaluation.contended,
        secondOpinionsRequested: evaluation.secondOpinionsRequested,
      },
      'Payments changed status',
    );
  }

  private reportScan(outcome: ScanOutcome): void {
    const logger = this.dependencies.logger;
    if (outcome.kind === 'halted') {
      // Halting is a decision that needs a human, so it is logged at the level that pages one.
      logger.error({ network: this.network, reason: outcome.reason }, 'Scanning is halted');
      return;
    }
    // Loud, because a window that reads back inconsistently means the endpoint served a fork or a
    // reorg landed mid-read. One is routine and self-correcting; a run of them is not.
    if (outcome.kind === 'discarded') {
      logger.warn(
        { event: 'scan.window_discarded', network: this.network, reason: outcome.reason },
        'A scanned window was discarded because a transfer disagreed with its own block header',
      );
      return;
    }
    if (outcome.kind === 'rewound') {
      logger.warn(
        {
          network: this.network,
          forkHeight: outcome.forkHeight.toString(),
          orphanedTransfers: outcome.orphanedTransfers,
        },
        'A fork was resolved and observations above it were withdrawn',
      );
      return;
    }
    if (outcome.kind === 'scanned' && outcome.transfersObserved > 0) {
      logger.info(
        {
          network: this.network,
          fromHeight: outcome.fromHeight.toString(),
          toHeight: outcome.toHeight.toString(),
          transfersObserved: outcome.transfersObserved,
        },
        'Transfers were observed',
      );
    }
  }

  /** Interruptible, so a shutdown does not wait out a full poll interval. */
  private sleep(milliseconds: number): Promise<void> {
    if (milliseconds === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(finish, milliseconds);
      this.wakeUp = finish;

      function finish(): void {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}
