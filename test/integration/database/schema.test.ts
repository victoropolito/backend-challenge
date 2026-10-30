import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, expectViolation, SqlState, type TestDatabase } from '../support/test-database';

type Row = Record<string, unknown>;

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, 30_000);

afterAll(async () => {
  await db?.drop();
});

const HASH = 'a'.repeat(64);
const NOW = '2026-10-30T12:00:00.000Z';

const insert = (table: string, row: Row) => {
  const columns = Object.keys(row);
  const placeholders = columns.map(() => '?').join(', ');
  return db.execute(`insert into ${table} (${columns.join(', ')}) values (${placeholders})`, Object.values(row));
};

const walletRow = (overrides: Row = {}): Row => ({
  id: randomUUID(),
  player_id: randomUUID(),
  currency: 'BRL',
  balance: '100.00',
  version: 1,
  created_at: NOW,
  updated_at: NOW,
  ...overrides,
});

const transactionRow = (walletId: string, overrides: Row = {}): Row => {
  const externalId = randomUUID();
  return {
    id: randomUUID(),
    provider_id: 'provider-a',
    external_transaction_id: externalId,
    idempotency_key: `provider-a:${externalId}`,
    payload_hash: HASH,
    wallet_id: walletId,
    player_id: 'player-1',
    round_id: 'round-1',
    game_id: 'game-1',
    kind: 'BET',
    amount: '25.00',
    currency: 'BRL',
    status: 'PROCESSED',
    processed_at: NOW,
    created_at: NOW,
    ...overrides,
  };
};

const ledgerRow = (walletId: string, transactionId: string, overrides: Row = {}): Row => ({
  id: randomUUID(),
  wallet_id: walletId,
  transaction_id: transactionId,
  direction: 'DEBIT',
  amount: '25.00',
  currency: 'BRL',
  balance_before: '100.00',
  balance_after: '75.00',
  created_at: NOW,
  ...overrides,
});

const createWallet = async (overrides: Row = {}) => {
  const row = walletRow(overrides);
  await insert('wallets', row);
  return row.id as string;
};

const createTransaction = async (walletId: string, overrides: Row = {}) => {
  const row = transactionRow(walletId, overrides);
  await insert('wager_transactions', row);
  return row;
};

const createBetWithEntry = async () => {
  const walletId = await createWallet();
  const bet = await createTransaction(walletId);
  const entry = ledgerRow(walletId, bet.id as string);
  await insert('wallet_ledger_entries', entry);
  return { walletId, bet, entry };
};

describe('migrations', () => {
  it('can be rolled back and reapplied', async () => {
    await db.orm.migrator.down({ to: 0 });
    const [afterDown] = await db.execute<{ count: string }>(
      `select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'wallets'`,
    );
    expect(Number(afterDown!.count)).toBe(0);

    await db.orm.migrator.up();
    expect(await db.orm.migrator.getPending()).toHaveLength(0);
  }, 30_000);
});

describe('wallets', () => {
  it('accepts a valid wallet', async () => {
    await createWallet();
  });

  it('allows at most one wallet per player and currency', async () => {
    const playerId = randomUUID();
    await createWallet({ player_id: playerId });
    await createWallet({ player_id: playerId, currency: 'USD' });
    await expectViolation(
      createWallet({ player_id: playerId }),
      SqlState.UniqueViolation,
      'wallets_player_currency_key',
    );
  });

  it('never stores a negative balance', async () => {
    await expectViolation(createWallet({ balance: '-0.01' }), SqlState.CheckViolation, 'wallets_balance_check');
  });

  it('rejects a version below 1', async () => {
    await expectViolation(createWallet({ version: 0 }), SqlState.CheckViolation, 'wallets_version_check');
  });

  it.each(['brl', 'BR', 'R$ '])('rejects currency %p', async (currency) => {
    await expectViolation(createWallet({ currency }), SqlState.CheckViolation, 'wallets_currency_check');
  });

  it('stores amounts exactly with scale 2', async () => {
    const id = await createWallet({ balance: '999999999999999999.99' });
    const [row] = await db.execute<{ balance: string }>('select balance::text as balance from wallets where id = ?', [id]);
    expect(row!.balance).toBe('999999999999999999.99');
  });
});

describe('wager_transactions', () => {
  let walletId: string;

  beforeAll(async () => {
    walletId = await createWallet();
  });

  it('accepts a processed BET', async () => {
    await createTransaction(walletId);
  });

  it('is unique per provider and external id', async () => {
    const first = await createTransaction(walletId);
    await createTransaction(walletId, {
      provider_id: 'provider-b',
      external_transaction_id: first.external_transaction_id,
      idempotency_key: first.idempotency_key,
    });
    await expectViolation(
      createTransaction(walletId, { external_transaction_id: first.external_transaction_id }),
      SqlState.UniqueViolation,
      'wager_transactions_provider_external_key',
    );
  });

  it('is unique per provider and idempotency key', async () => {
    const first = await createTransaction(walletId);
    await expectViolation(
      createTransaction(walletId, { idempotency_key: first.idempotency_key }),
      SqlState.UniqueViolation,
      'wager_transactions_provider_idempotency_key',
    );
  });

  it('requires a SHA-256 hex payload hash', async () => {
    await expectViolation(
      createTransaction(walletId, { payload_hash: 'Z'.repeat(64) }),
      SqlState.CheckViolation,
      'wager_transactions_payload_hash_check',
    );
  });

  it.each(['TRANSFER', 'bet'])('rejects kind %p', async (kind) => {
    await expectViolation(createTransaction(walletId, { kind }), SqlState.CheckViolation, 'wager_transactions_kind_check');
  });

  it('rejects an unknown status', async () => {
    await expectViolation(
      createTransaction(walletId, { status: 'DONE' }),
      SqlState.CheckViolation,
      'wager_transactions_status_check',
    );
  });

  describe('amount', () => {
    it('must be positive except for LOSS', async () => {
      await expectViolation(
        createTransaction(walletId, { amount: '0.00' }),
        SqlState.CheckViolation,
        'wager_transactions_amount_positive_check',
      );
      await createTransaction(walletId, { kind: 'LOSS', amount: '0.00' });
    });

    it('is never negative', async () => {
      await expectViolation(createTransaction(walletId, { kind: 'LOSS', amount: '-1.00' }), SqlState.CheckViolation);
    });
  });

  describe('references', () => {
    it.each(['REFUND', 'ROLLBACK'])('%s requires a reference', async (kind) => {
      await expectViolation(
        createTransaction(walletId, { kind, status: 'PENDING', processed_at: null }),
        SqlState.CheckViolation,
        'wager_transactions_reference_required_check',
      );
    });

    it('BET must not have a reference', async () => {
      await expectViolation(
        createTransaction(walletId, { reference_external_transaction_id: 'ext-0' }),
        SqlState.CheckViolation,
        'wager_transactions_reference_forbidden_check',
      );
    });

    it('a resolved reference must point to an existing transaction', async () => {
      await expectViolation(
        createTransaction(walletId, {
          kind: 'REFUND',
          reference_external_transaction_id: 'ext-0',
          reference_transaction_id: randomUUID(),
        }),
        SqlState.ForeignKeyViolation,
      );
    });

    it('PROCESSED with an external reference must have it resolved', async () => {
      await expectViolation(
        createTransaction(walletId, { kind: 'REFUND', reference_external_transaction_id: 'ext-0' }),
        SqlState.CheckViolation,
        'wager_transactions_status_consistency_check',
      );
    });

    it('allows only one processed reversal of each kind per reference', async () => {
      const bet = await createTransaction(walletId);
      const reversal = (kind: string, status = 'PROCESSED') =>
        createTransaction(walletId, {
          kind,
          status,
          reference_external_transaction_id: bet.external_transaction_id,
          reference_transaction_id: bet.id,
          ...(status === 'REJECTED' ? { failure_code: 'REFERENCE_ALREADY_REVERSED', processed_at: null } : {}),
        });

      await reversal('REFUND');
      await reversal('REFUND', 'REJECTED');
      await reversal('ROLLBACK');
      await expectViolation(reversal('REFUND'), SqlState.UniqueViolation, 'wager_transactions_single_reversal_idx');
      await expectViolation(reversal('ROLLBACK'), SqlState.UniqueViolation, 'wager_transactions_single_reversal_idx');
    });
  });

  describe('OPENING', () => {
    it('is reserved to the internal provider', async () => {
      await createTransaction(walletId, { kind: 'OPENING', provider_id: 'internal' });
      await expectViolation(
        createTransaction(walletId, { kind: 'OPENING' }),
        SqlState.CheckViolation,
        'wager_transactions_opening_internal_check',
      );
      await expectViolation(
        createTransaction(walletId, { provider_id: 'internal' }),
        SqlState.CheckViolation,
        'wager_transactions_opening_internal_check',
      );
    });
  });

  describe('status consistency', () => {
    const pendingReference = {
      kind: 'REFUND',
      reference_external_transaction_id: 'ext-0',
      status: 'PENDING_REFERENCE',
      processed_at: null,
      next_reference_check_at: NOW,
      reference_check_attempts: 1,
    };

    it.each<[string, Row]>([
      ['PENDING', { status: 'PENDING', processed_at: null }],
      ['PENDING_REFERENCE', pendingReference],
      ['REJECTED', { status: 'REJECTED', processed_at: null, failure_code: 'INSUFFICIENT_BALANCE' }],
      ['FAILED', { status: 'FAILED', processed_at: null, failure_code: 'PROCESSING_ERROR' }],
    ])('accepts a consistent %s', async (_, overrides) => {
      await createTransaction(walletId, overrides);
    });

    it.each<[string, Row]>([
      ['PROCESSED without processed_at', { processed_at: null }],
      ['PROCESSED with failure_code', { failure_code: 'INSUFFICIENT_BALANCE' }],
      ['PENDING with processed_at', { status: 'PENDING' }],
      ['PENDING with next check', { status: 'PENDING', processed_at: null, next_reference_check_at: NOW }],
      ['PENDING_REFERENCE without next check', { ...pendingReference, next_reference_check_at: null }],
      ['PENDING_REFERENCE without reference', { status: 'PENDING_REFERENCE', processed_at: null, next_reference_check_at: NOW }],
      ['REJECTED without failure_code', { status: 'REJECTED', processed_at: null }],
      ['FAILED without failure_code', { status: 'FAILED', processed_at: null }],
      ['REJECTED with processed_at', { status: 'REJECTED', failure_code: 'INSUFFICIENT_BALANCE' }],
    ])('rejects %s', async (_, overrides) => {
      await expectViolation(createTransaction(walletId, overrides), SqlState.CheckViolation, 'wager_transactions_status_consistency_check');
    });
  });
});

describe('wallet_ledger_entries', () => {
  it('accepts a balanced entry and assigns an increasing sequence', async () => {
    const first = await createBetWithEntry();
    const second = await createBetWithEntry();
    const rows = await db.execute<{ id: string; sequence: string }>(
      'select id, sequence::text as sequence from wallet_ledger_entries where id in (?, ?)',
      [first.entry.id, second.entry.id],
    );
    const sequenceOf = (id: unknown) => BigInt(rows.find((r) => r.id === id)!.sequence);
    expect(sequenceOf(second.entry.id)).toBeGreaterThan(sequenceOf(first.entry.id));
  });

  it.each<[string, Row]>([
    ['debit with wrong balance after', { balance_after: '76.00' }],
    ['credit computed as debit', { direction: 'CREDIT' }],
  ])('rejects an unbalanced entry: %s', async (_, overrides) => {
    const walletId = await createWallet();
    const bet = await createTransaction(walletId);
    await expectViolation(
      insert('wallet_ledger_entries', ledgerRow(walletId, bet.id as string, overrides)),
      SqlState.CheckViolation,
      'wallet_ledger_entries_balanced_check',
    );
  });

  it('rejects a negative balance after', async () => {
    const walletId = await createWallet();
    const bet = await createTransaction(walletId);
    await expectViolation(
      insert('wallet_ledger_entries', ledgerRow(walletId, bet.id as string, { balance_before: '10.00', balance_after: '-15.00' })),
      SqlState.CheckViolation,
      'wallet_ledger_entries_balance_after_check',
    );
  });

  it('allows at most one entry per transaction and wallet', async () => {
    const { walletId, bet } = await createBetWithEntry();
    await expectViolation(
      insert('wallet_ledger_entries', ledgerRow(walletId, bet.id as string)),
      SqlState.UniqueViolation,
      'wallet_ledger_entries_wallet_transaction_key',
    );
  });

  it('must use the wallet currency', async () => {
    const walletId = await createWallet();
    const bet = await createTransaction(walletId, { currency: 'USD' });
    await expectViolation(
      insert('wallet_ledger_entries', ledgerRow(walletId, bet.id as string, { currency: 'USD' })),
      SqlState.ForeignKeyViolation,
      'wallet_ledger_entries_wallet_fk',
    );
  });

  it('must belong to the same wallet as its transaction', async () => {
    const walletId = await createWallet();
    const otherWalletId = await createWallet();
    const bet = await createTransaction(otherWalletId);
    await expectViolation(
      insert('wallet_ledger_entries', ledgerRow(walletId, bet.id as string)),
      SqlState.ForeignKeyViolation,
      'wallet_ledger_entries_transaction_fk',
    );
  });

  it('must move exactly the transaction amount', async () => {
    const walletId = await createWallet();
    const bet = await createTransaction(walletId);
    await expectViolation(
      insert('wallet_ledger_entries', ledgerRow(walletId, bet.id as string, { amount: '30.00', balance_after: '70.00' })),
      SqlState.ForeignKeyViolation,
      'wallet_ledger_entries_transaction_fk',
    );
  });

  describe('is append-only', () => {
    it('rejects UPDATE', async () => {
      const { entry } = await createBetWithEntry();
      await expectViolation(
        db.execute(`update wallet_ledger_entries set created_at = now() where id = ?`, [entry.id]),
        SqlState.RestrictViolation,
      );
    });

    it('rejects DELETE', async () => {
      const { entry } = await createBetWithEntry();
      await expectViolation(db.execute('delete from wallet_ledger_entries where id = ?', [entry.id]), SqlState.RestrictViolation);
      const rows = await db.execute('select 1 from wallet_ledger_entries where id = ?', [entry.id]);
      expect(rows).toHaveLength(1);
    });

    it('rejects TRUNCATE', async () => {
      await createBetWithEntry();
      await expectViolation(db.execute('truncate wallet_ledger_entries'), SqlState.RestrictViolation);
    });

    it('prevents deleting a wallet or transaction that has entries', async () => {
      const { walletId, bet } = await createBetWithEntry();
      await expectViolation(db.execute('delete from wallets where id = ?', [walletId]), SqlState.ForeignKeyViolation);
      await expectViolation(db.execute('delete from wager_transactions where id = ?', [bet.id]), SqlState.ForeignKeyViolation);
    });
  });
});

describe('inbox_messages', () => {
  const inboxRow = (overrides: Row = {}): Row => ({
    consumer_name: 'wager-transactions',
    message_id: randomUUID(),
    payload_hash: HASH,
    received_at: NOW,
    ...overrides,
  });

  it('deduplicates by consumer and message id', async () => {
    const row = inboxRow();
    await insert('inbox_messages', row);
    await insert('inbox_messages', { ...row, consumer_name: 'other-consumer' });
    await expectViolation(insert('inbox_messages', row), SqlState.UniqueViolation, 'inbox_messages_pkey');
  });
});

describe('outbox_messages', () => {
  const outboxRow = (overrides: Row = {}): Row => ({
    id: randomUUID(),
    aggregate_id: randomUUID(),
    event_type: 'WalletBalanceChanged',
    payload: JSON.stringify({ eventId: 'e-1' }),
    occurred_at: NOW,
    ...overrides,
  });

  it('accepts a pending message with defaults', async () => {
    const row = outboxRow();
    await insert('outbox_messages', row);
    const [stored] = await db.execute<{ attempts: number; published_at: unknown }>(
      'select attempts, published_at from outbox_messages where id = ?',
      [row.id],
    );
    expect(stored).toEqual({ attempts: 0, published_at: null });
  });

  it('requires a JSON object payload', async () => {
    await expectViolation(
      insert('outbox_messages', outboxRow({ payload: JSON.stringify([1, 2]) })),
      SqlState.CheckViolation,
      'outbox_messages_payload_check',
    );
  });

  it('does not schedule retries for a published message', async () => {
    await expectViolation(
      insert('outbox_messages', outboxRow({ published_at: NOW, next_attempt_at: NOW })),
      SqlState.CheckViolation,
      'outbox_messages_published_check',
    );
  });
});
