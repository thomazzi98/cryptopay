import type {
  DeliverCallbacksUseCase,
  DeliveryOutcome,
} from '../application/deliver-callbacks.use-case.js';
import type { StructuredLogger } from '../observability/logger.js';

/**
 * The process that drains the callback outbox.
 *
 * It holds no lease. Concurrency is settled by the claim, which takes at most one delivery per
 * merchant environment, and by the partial unique index that makes a second in-flight claim for the
 * same merchant impossible. Any number of these can run, and adding one adds throughput rather than
 * duplicate deliveries.
 *
 * It is a separate process from the API and the chain worker for containment. This is the only part
 * of the system that makes outbound requests to addresses a stranger chose, so it gets its own
 * container, its own database role and its own network policy; a compromise here reaches as little
 * as possible.
 */

export interface CallbackWorkerOptions {
  readonly idlePollIntervalMilliseconds: number;
  readonly errorBackoffMilliseconds: number;
}

const DEFAULT_OPTIONS: CallbackWorkerOptions = Object.freeze({
  idlePollIntervalMilliseconds: 2000,
  errorBackoffMilliseconds: 10_000,
});

export interface CallbackWorkerDependencies {
  readonly deliverer: DeliverCallbacksUseCase;
  readonly logger: StructuredLogger;
  readonly options?: CallbackWorkerOptions;
}

export class CallbackWorker {
  private readonly dependencies: CallbackWorkerDependencies;
  private readonly options: CallbackWorkerOptions;
  private running = false;
  private wakeUp: (() => void) | null = null;

  constructor(dependencies: CallbackWorkerDependencies) {
    this.dependencies = dependencies;
    this.options = dependencies.options ?? DEFAULT_OPTIONS;
  }

  async runOnce(): Promise<DeliveryOutcome> {
    const outcome = await this.dependencies.deliverer.execute();
    this.report(outcome);
    return outcome;
  }

  async start(): Promise<void> {
    this.running = true;
    for (;;) {
      const delay = await this.tickAndChooseDelay();
      await this.sleep(delay);
      if (!this.shouldKeepRunning()) {
        return;
      }
    }
  }

  stop(): void {
    this.running = false;
    this.wakeUp?.();
  }

  private shouldKeepRunning(): boolean {
    return this.running;
  }

  private async tickAndChooseDelay(): Promise<number> {
    try {
      const outcome = await this.runOnce();
      // Work was found, so more is probably waiting. Sleeping here would add the poll interval to
      // every merchant's notification latency for no reason.
      if (outcome.claimed > 0) {
        return 0;
      }
      return this.options.idlePollIntervalMilliseconds;
    } catch (error) {
      this.dependencies.logger.error({ error }, 'The callback delivery tick failed');
      return this.options.errorBackoffMilliseconds;
    }
  }

  private report(outcome: DeliveryOutcome): void {
    if (outcome.blocked > 0) {
      // A blocked destination is a merchant configuration problem they need to be told about, and it
      // is also what a probe against the SSRF policy looks like from the inside.
      this.dependencies.logger.warn(
        { blocked: outcome.blocked },
        'Callback destinations were refused by the destination policy',
      );
    }
    if (outcome.claimed === 0) {
      return;
    }
    this.dependencies.logger.info(
      {
        claimed: outcome.claimed,
        delivered: outcome.delivered,
        retrying: outcome.retrying,
        abandoned: outcome.abandoned,
      },
      'Callbacks were attempted',
    );
  }

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
