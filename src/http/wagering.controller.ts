import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import { SubmitWagerTransactionUseCase } from '../application/wagering/submit-wager-transaction.use-case';
import { WagerTransactionQueries } from '../application/wagering/wager-transaction-queries';
import { Money } from '../domain/shared/money';
import { CorrelationId } from './correlation-id';
import type { HttpResponse } from './http-types';
import { submissionResponse, submissionStatus, transactionResponse } from './presenters';
import { parseRequest } from './request-validation';
import {
  ExternalTransactionParams,
  IdempotencyKeyHeader,
  SubmitWagerTransactionBody,
  TransactionParams,
} from './schemas';

/** Submissão e consulta de transações de aposta. */
@Controller()
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransactionUseCase) private readonly submitTransaction: SubmitWagerTransactionUseCase,
    @Inject(WagerTransactionQueries) private readonly queries: WagerTransactionQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKeyHeader: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const idempotencyKey = parseRequest(IdempotencyKeyHeader, idempotencyKeyHeader, 'headers.idempotency-key');
    const input = parseRequest(SubmitWagerTransactionBody, body, 'body');
    const result = await this.submitTransaction.execute({
      ...input,
      idempotencyKey,
      money: Money.from(input.money),
      referenceExternalTransactionId: input.referenceExternalTransactionId ?? undefined,
      correlationId,
    });
    response.status(submissionStatus(result.transaction));
    return submissionResponse(result);
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param() params: unknown) {
    const { transactionId } = parseRequest(TransactionParams, params, 'params');
    return transactionResponse(await this.queries.getById(transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(@Param() params: unknown) {
    const { providerId, externalTransactionId } = parseRequest(ExternalTransactionParams, params, 'params');
    return transactionResponse(await this.queries.getByExternalId(providerId, externalTransactionId));
  }
}
