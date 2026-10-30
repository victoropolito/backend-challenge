import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { addLogContext, withLogContext } from '../../../src/infrastructure/observability/log-context';
import { NestJsonLogger } from '../../../src/infrastructure/observability/nest-json-logger';
import { configureLogging, StructuredLogger } from '../../../src/infrastructure/observability/structured-logger';

let lines: Record<string, unknown>[];

beforeEach(() => {
  lines = [];
  configureLogging({ level: 'debug', write: (line) => lines.push(JSON.parse(line)) });
});

afterEach(() => {
  configureLogging({ level: 'silent' });
});

describe('StructuredLogger', () => {
  it('writes one JSON object per event with time, level, context, message and fields', () => {
    new StructuredLogger('Test').info('Something happened', { transactionId: 'tx-1', attempt: 2 });

    expect(lines).toEqual([
      {
        time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
        level: 'info',
        context: 'Test',
        message: 'Something happened',
        transactionId: 'tx-1',
        attempt: 2,
      },
    ]);
  });

  it('drops events below the configured level', () => {
    configureLogging({ level: 'warn' });
    const logger = new StructuredLogger('Test');

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(lines.map((line) => line.level)).toEqual(['warn', 'error']);
  });

  it('silent drops everything', () => {
    configureLogging({ level: 'silent' });
    new StructuredLogger('Test').error('e');
    expect(lines).toEqual([]);
  });

  it('serializes the error with name, message and stack', () => {
    new StructuredLogger('Test').error('Failed', { walletId: 'w-1' }, new TypeError('boom'));

    expect(lines[0]).toMatchObject({ level: 'error', walletId: 'w-1', error: { name: 'TypeError', message: 'boom' } });
    expect((lines[0]!.error as { stack: string }).stack).toContain('boom');
  });

  it('omits undefined fields', () => {
    new StructuredLogger('Test').info('x', { failureCode: undefined });
    expect('failureCode' in lines[0]!).toBe(false);
  });
});

describe('log context', () => {
  it('adds the context fields to every log inside it, across awaits, and the call fields win', async () => {
    const logger = new StructuredLogger('Test');

    await withLogContext({ correlationId: 'corr-1', walletId: 'w-1' }, async () => {
      await Bun.sleep(1);
      logger.info('inside', { walletId: 'w-2' });
    });
    logger.info('outside');

    expect(lines[0]).toMatchObject({ correlationId: 'corr-1', walletId: 'w-2' });
    expect('correlationId' in lines[1]!).toBe(false);
  });

  it('nested contexts add to the outer one without changing it', () => {
    const logger = new StructuredLogger('Test');

    withLogContext({ correlationId: 'corr-1' }, () => {
      withLogContext({ messageId: 'msg-1' }, () => logger.info('inner'));
      logger.info('outer');
    });

    expect(lines[0]).toMatchObject({ correlationId: 'corr-1', messageId: 'msg-1' });
    expect('messageId' in lines[1]!).toBe(false);
  });

  it('addLogContext enriches the current context, and concurrent contexts stay apart', async () => {
    const logger = new StructuredLogger('Test');
    const handle = (messageId: string, walletId: string) =>
      withLogContext({ messageId }, async () => {
        await Bun.sleep(5);
        addLogContext({ walletId });
        await Bun.sleep(5);
        logger.info('processed');
      });

    await Promise.all([handle('msg-1', 'w-1'), handle('msg-2', 'w-2')]);
    addLogContext({ walletId: 'ignored' });
    logger.info('outside');

    expect(lines.slice(0, 2).map((line) => [line.messageId, line.walletId]).sort()).toEqual([
      ['msg-1', 'w-1'],
      ['msg-2', 'w-2'],
    ]);
    expect('walletId' in lines[2]!).toBe(false);
  });
});

describe('NestJsonLogger', () => {
  it('uses the last string parameter as context', () => {
    new NestJsonLogger().log('Nest application successfully started', 'NestApplication');
    expect(lines[0]).toMatchObject({ level: 'info', context: 'NestApplication', message: 'Nest application successfully started' });
  });

  it('keeps the stack of framework errors', () => {
    new NestJsonLogger().error('Failed to start', 'Error: x\n    at y', 'Bootstrap');
    expect(lines[0]).toMatchObject({ level: 'error', context: 'Bootstrap', message: 'Failed to start', stack: 'Error: x\n    at y' });
  });

  it('logs an Error instance with its details', () => {
    new NestJsonLogger().error(new Error('kaput'));
    expect(lines[0]).toMatchObject({ level: 'error', context: 'Nest', message: 'kaput', error: { name: 'Error', message: 'kaput' } });
  });
});
