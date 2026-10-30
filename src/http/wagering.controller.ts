import { Body, Controller, Get, Headers, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import { SubmitWagerTransactionUseCase } from '../application/wagering/submit-wager-transaction.use-case';
import {
  WagerTransactionNotFoundError,
  WagerTransactionQueries,
} from '../application/wagering/wager-transaction-queries';
import { Money } from '../domain/shared/money';
import { AuthenticatedPrincipal, AuthenticationGuard } from './auth/authentication.guard';
import { assertProviderAccess, canAccessProvider, type Principal } from './auth/request-authenticator';
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

/** Submissão e consulta de transações de aposta; uma credencial de provider só age sobre as transações dele. */
@Controller()
@UseGuards(AuthenticationGuard)
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
    @AuthenticatedPrincipal() principal: Principal,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const idempotencyKey = parseRequest(IdempotencyKeyHeader, idempotencyKeyHeader, 'headers.idempotency-key');
    const input = parseRequest(SubmitWagerTransactionBody, body, 'body');
    assertProviderAccess(principal, input.providerId);
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
  async getById(@Param() params: unknown, @AuthenticatedPrincipal() principal: Principal) {
    const { transactionId } = parseRequest(TransactionParams, params, 'params');
    const transaction = await this.queries.getById(transactionId);
    if (!canAccessProvider(principal, transaction.providerId)) {
      throw new WagerTransactionNotFoundError(`Transaction ${transactionId} does not exist`);
    }
    return transactionResponse(transaction);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(@Param() params: unknown, @AuthenticatedPrincipal() principal: Principal) {
    const { providerId, externalTransactionId } = parseRequest(ExternalTransactionParams, params, 'params');
    assertProviderAccess(principal, providerId);
    return transactionResponse(await this.queries.getByExternalId(providerId, externalTransactionId));
  }
}
