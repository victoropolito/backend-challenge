import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { CreateWalletUseCase } from '../application/wallet/create-wallet.use-case';
import { ReconcileWalletUseCase } from '../application/wallet/reconcile-wallet.use-case';
import { WalletQueries } from '../application/wallet/wallet-queries';
import { Money } from '../domain/shared/money';
import { CorrelationId } from './correlation-id';
import { ledgerPageResponse, reconciliationResponse, walletResponse } from './presenters';
import { parseRequest } from './request-validation';
import { CreateWalletBody, LedgerQuery, WalletParams } from './schemas';

/** Criação e consulta de wallets e do ledger. */
@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
    @Inject(ReconcileWalletUseCase) private readonly reconcileWallet: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @CorrelationId() correlationId: string) {
    const { playerId, initialBalance } = parseRequest(CreateWalletBody, body, 'body');
    const wallet = await this.createWallet.execute({
      playerId,
      initialBalance: Money.from(initialBalance),
      correlationId,
    });
    return walletResponse(wallet);
  }

  @Get(':walletId')
  async get(@Param() params: unknown) {
    const { walletId } = parseRequest(WalletParams, params, 'params');
    return walletResponse(await this.queries.getWallet(walletId));
  }

  @Get(':walletId/ledger')
  async ledger(@Param() params: unknown, @Query() query: unknown) {
    const { walletId } = parseRequest(WalletParams, params, 'params');
    const { cursor, limit } = parseRequest(LedgerQuery, query, 'query');
    return ledgerPageResponse(await this.queries.listLedger(walletId, { cursor, limit }));
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param() params: unknown) {
    const { walletId } = parseRequest(WalletParams, params, 'params');
    return reconciliationResponse(await this.reconcileWallet.execute(walletId));
  }
}
