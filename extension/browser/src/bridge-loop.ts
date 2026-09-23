export type BridgeLoopCoordinatorOptions = {
  hasConfig(): Promise<boolean>;
  runLoop(): Promise<void>;
  onLoopError?(error: unknown): void;
};

export class BridgeLoopCoordinator {
  readonly #hasConfig: () => Promise<boolean>;
  readonly #runLoop: () => Promise<void>;
  readonly #onLoopError:
    | ((error: unknown) => void)
    | undefined;

  #running: Promise<void> | null = null;
  #starting: Promise<boolean> | null = null;

  constructor(options: BridgeLoopCoordinatorOptions) {
    this.#hasConfig = options.hasConfig;
    this.#runLoop = options.runLoop;
    this.#onLoopError = options.onLoopError;
  }

  ensureRunning(): Promise<boolean> {
    if (this.#running !== null) {
      return Promise.resolve(true);
    }

    if (this.#starting !== null) {
      return this.#starting;
    }

    const starting = this.#start();
    this.#starting = starting;
    return starting;
  }

  async #start(): Promise<boolean> {
    try {
      if (!(await this.#hasConfig())) {
        return false;
      }

      if (this.#running !== null) {
        return true;
      }

      let tracked!: Promise<void>;

      tracked = Promise.resolve()
        .then(() => this.#runLoop())
        .catch((error: unknown) => {
          this.#onLoopError?.(error);
        })
        .finally(() => {
          if (this.#running === tracked) {
            this.#running = null;
          }
        });

      this.#running = tracked;
      return true;
    } finally {
      this.#starting = null;
    }
  }
}