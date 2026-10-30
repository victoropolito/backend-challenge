export interface PollingLoopOptions {
  /** Executa um lote; retorna true quando provavelmente há mais trabalho e o próximo lote deve começar já. */
  tick(): Promise<boolean>;
  /** Espera entre lotes quando não há mais trabalho (ou depois de um erro). */
  idleDelayMs: number;
  onError(error: unknown): void;
}

/** Loop de lotes em segundo plano. `stop` interrompe a espera e aguarda o lote em andamento. */
export class PollingLoop {
  private running = false;
  private loop: Promise<void> | undefined;
  private wakeUp: (() => void) | undefined;

  constructor(private readonly options: PollingLoopOptions) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wakeUp?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    const { tick, idleDelayMs, onError } = this.options;
    while (this.running) {
      try {
        if (!(await tick())) {
          await this.pause(idleDelayMs);
        }
      } catch (error) {
        onError(error);
        await this.pause(idleDelayMs);
      }
    }
  }

  private pause(ms: number): Promise<void> {
    if (!this.running) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wakeUp = done;
    });
  }
}
