import { join } from 'node:path';
import type { Subprocess } from 'bun';

export interface AppInstance {
  readonly name: string;
  readonly url: string;
  readonly process: Subprocess;
  /** Saída do processo (stdout e stderr), para diagnosticar falhas. */
  readonly output: string[];
  /** Mata o processo sem shutdown gracioso (crash), e espera ele sair. */
  kill(): Promise<void>;
}

const ROOT = join(import.meta.dir, '..', '..', '..');
const READY_TIMEOUT_MS = 30_000;

/** Porta TCP livre no momento da chamada. */
function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port!;
  server.stop(true);
  return port;
}

async function collect(stream: ReadableStream<Uint8Array>, into: string[]): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    into.push(decoder.decode(chunk));
  }
}

/**
 * Sobe uma instância da aplicação (`src/main.ts`) num processo separado, com o ambiente dado sobre o do processo de
 * teste, e espera o readiness responder 200.
 */
export async function startAppInstance(name: string, env: Record<string, string>): Promise<AppInstance> {
  const port = freePort();
  const output: string[] = [];
  const child = Bun.spawn([process.execPath, 'run', 'src/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, LOG_LEVEL: 'warn', ...env, PORT: String(port) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  void collect(child.stdout, output);
  void collect(child.stderr, output);

  const instance: AppInstance = {
    name,
    url: `http://localhost:${port}`,
    process: child,
    output,
    async kill() {
      child.kill('SIGKILL');
      await child.exited;
    },
  };

  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`Instance ${name} exited with ${child.exitCode}:\n${output.join('')}`);
    }
    const ready = await fetch(`${instance.url}/health/ready`).then(
      (response) => response.status === 200,
      () => false,
    );
    if (ready) {
      return instance;
    }
    if (Date.now() > deadline) {
      await instance.kill();
      throw new Error(`Instance ${name} not ready after ${READY_TIMEOUT_MS} ms:\n${output.join('')}`);
    }
    await Bun.sleep(200);
  }
}
