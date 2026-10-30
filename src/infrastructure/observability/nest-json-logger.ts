import type { LoggerService } from '@nestjs/common';
import { StructuredLogger } from './structured-logger';

/** LoggerService do NestJS que encaminha os logs do framework para o StructuredLogger (uma linha JSON por evento). */
export class NestJsonLogger implements LoggerService {
  log(message: unknown, ...params: unknown[]): void {
    this.loggerFor(params).info(stringify(message));
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.loggerFor(params).debug(stringify(message));
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.loggerFor(params).debug(stringify(message));
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.loggerFor(params).warn(stringify(message));
  }

  error(message: unknown, ...params: unknown[]): void {
    const logger = this.loggerFor(params);
    if (message instanceof Error) {
      logger.error(message.message, undefined, message);
      return;
    }
    const stack = params.find((param) => typeof param === 'string' && param.includes('\n'));
    logger.error(stringify(message), stack === undefined ? undefined : { stack: stack as string });
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.error(message, ...params);
  }

  /** O NestJS passa o contexto como último parâmetro string. */
  private loggerFor(params: unknown[]): StructuredLogger {
    const context = params.at(-1);
    return new StructuredLogger(typeof context === 'string' && !context.includes('\n') ? context : 'Nest');
  }
}

function stringify(message: unknown): string {
  return typeof message === 'string' ? message : JSON.stringify(message);
}
