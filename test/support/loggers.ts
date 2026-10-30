import type { LogFields } from '../../src/infrastructure/observability/log-context';
import type { AppLogger } from '../../src/infrastructure/observability/structured-logger';

export const silentLogger: AppLogger = { debug() {}, info() {}, warn() {}, error() {} };

export interface RecordedLog {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields: LogFields | undefined;
  error?: unknown;
}

/** Logger que guarda as chamadas, para os testes conferirem nível, mensagem e campos. */
export class RecordingLogger implements AppLogger {
  readonly entries: RecordedLog[] = [];

  debug(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'debug', message, fields });
  }

  info(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'info', message, fields });
  }

  warn(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'warn', message, fields });
  }

  error(message: string, fields?: LogFields, error?: unknown): void {
    this.entries.push({ level: 'error', message, fields, error });
  }
}
