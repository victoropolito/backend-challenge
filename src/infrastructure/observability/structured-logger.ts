import { currentLogContext, type LogFields } from './log-context';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevelName = (typeof LOG_LEVELS)[number];
type EmittedLevel = Exclude<LogLevelName, 'silent'>;

const SEVERITY: Record<LogLevelName, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Logger usado pelos adaptadores (consumidor, workers, HTTP, monitores). */
export interface AppLogger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields, error?: unknown): void;
}

export interface LoggingSettings {
  level: LogLevelName;
  write(line: string): void;
}

const settings: LoggingSettings = {
  level: 'info',
  write: (line) => process.stdout.write(`${line}\n`),
};

/** Ajusta o nível mínimo e o destino de todos os loggers do processo. */
export function configureLogging(changes: Partial<LoggingSettings>): void {
  Object.assign(settings, changes);
}

/**
 * Escreve uma linha JSON por evento: `time`, `level`, `context`, `message`, os campos do contexto corrente
 * (`withLogContext`), os campos da chamada e, em erros, `error` com nome, mensagem e stack.
 */
export class StructuredLogger implements AppLogger {
  constructor(readonly context: string) {}

  debug(message: string, fields?: LogFields): void {
    this.emit('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.emit('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.emit('warn', message, fields);
  }

  error(message: string, fields?: LogFields, error?: unknown): void {
    this.emit('error', message, fields, error);
  }

  private emit(level: EmittedLevel, message: string, fields: LogFields | undefined, error?: unknown): void {
    if (SEVERITY[level] < SEVERITY[settings.level]) {
      return;
    }
    const entry = {
      time: new Date().toISOString(),
      level,
      context: this.context,
      message,
      ...currentLogContext(),
      ...fields,
      ...(error === undefined ? {} : { error: serializeError(error) }),
    };
    settings.write(JSON.stringify(entry));
  }
}

function serializeError(error: unknown): { name: string; message: string; stack?: string | undefined } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: 'NonError', message: String(error) };
}
