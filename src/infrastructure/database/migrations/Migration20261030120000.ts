import { Migration } from '@mikro-orm/migrations';

/** Schema inicial: wallets, transações, ledger imutável, inbox e outbox, com as invariantes garantidas por constraints. */
export class Migration20261030120000 extends Migration {
  override name = 'Migration20261030120000';

  override up(): void {
    this.addSql(`
      create table wallets (
        id          uuid           primary key,
        player_id   text           not null check (btrim(player_id) <> ''),
        currency    char(3)        not null check (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20, 2) not null check (balance >= 0),
        version     integer        not null check (version >= 1),
        created_at  timestamptz(3) not null,
        updated_at  timestamptz(3) not null,
        constraint wallets_player_currency_key unique (player_id, currency),
        constraint wallets_id_currency_key unique (id, currency)
      );
    `);

    this.addSql(`
      create table wager_transactions (
        id                                uuid           primary key,
        provider_id                       text           not null check (btrim(provider_id) <> ''),
        external_transaction_id           text           not null check (btrim(external_transaction_id) <> ''),
        idempotency_key                   text           not null check (btrim(idempotency_key) <> ''),
        payload_hash                      char(64)       not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        wallet_id                         uuid           not null,
        player_id                         text           not null check (btrim(player_id) <> ''),
        round_id                          text           not null check (btrim(round_id) <> ''),
        game_id                           text           not null check (btrim(game_id) <> ''),
        kind                              text           not null
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount                            numeric(20, 2) not null check (amount >= 0),
        currency                          char(3)        not null check (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id text,
        status                            text           not null
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        reference_transaction_id          uuid           references wager_transactions (id),
        failure_code                      text,
        processed_at                      timestamptz(3),
        reference_check_attempts          integer        not null default 0 check (reference_check_attempts >= 0),
        next_reference_check_at           timestamptz(3),
        created_at                        timestamptz(3) not null,

        constraint wager_transactions_provider_external_key unique (provider_id, external_transaction_id),
        constraint wager_transactions_provider_idempotency_key unique (provider_id, idempotency_key),
        constraint wager_transactions_ledger_key unique (id, wallet_id, currency, amount),

        constraint wager_transactions_amount_positive_check
          check (amount > 0 or kind = 'LOSS'),
        constraint wager_transactions_reference_required_check
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_transactions_reference_forbidden_check
          check (kind not in ('OPENING', 'BET') or reference_external_transaction_id is null),
        constraint wager_transactions_reference_resolved_check
          check (reference_transaction_id is null or reference_external_transaction_id is not null),
        constraint wager_transactions_opening_internal_check
          check ((kind = 'OPENING') = (provider_id = 'internal')),

        constraint wager_transactions_status_consistency_check check (
          case status
            when 'PENDING' then
              failure_code is null and processed_at is null and next_reference_check_at is null
            when 'PENDING_REFERENCE' then
              failure_code is null and processed_at is null and next_reference_check_at is not null
              and reference_external_transaction_id is not null
            when 'PROCESSED' then
              failure_code is null and processed_at is not null and next_reference_check_at is null
              and (reference_external_transaction_id is null) = (reference_transaction_id is null)
            else
              failure_code is not null and processed_at is null and next_reference_check_at is null
          end
        )
      );
    `);

    this.addSql(`
      create unique index wager_transactions_single_reversal_idx
        on wager_transactions (reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
    `);
    this.addSql(`
      create index wager_transactions_pending_reference_due_idx
        on wager_transactions (next_reference_check_at)
        where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      create index wager_transactions_pending_reference_lookup_idx
        on wager_transactions (provider_id, reference_external_transaction_id)
        where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`create index wager_transactions_wallet_idx on wager_transactions (wallet_id, created_at);`);

    this.addSql(`
      create table wallet_ledger_entries (
        id              uuid           primary key,
        sequence        bigint         generated always as identity unique,
        wallet_id       uuid           not null,
        transaction_id  uuid           not null,
        direction       text           not null check (direction in ('DEBIT', 'CREDIT')),
        amount          numeric(20, 2) not null check (amount > 0),
        currency        char(3)        not null,
        balance_before  numeric(20, 2) not null check (balance_before >= 0),
        balance_after   numeric(20, 2) not null check (balance_after >= 0),
        created_at      timestamptz(3) not null,

        constraint wallet_ledger_entries_wallet_fk
          foreign key (wallet_id, currency) references wallets (id, currency),
        constraint wallet_ledger_entries_transaction_fk
          foreign key (transaction_id, wallet_id, currency, amount)
          references wager_transactions (id, wallet_id, currency, amount),
        constraint wallet_ledger_entries_wallet_transaction_key unique (wallet_id, transaction_id),
        constraint wallet_ledger_entries_balanced_check check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT' and balance_after = balance_before - amount)
        )
      );
    `);
    this.addSql(`create index wallet_ledger_entries_wallet_sequence_idx on wallet_ledger_entries (wallet_id, sequence);`);

    this.addSql(`
      create function wallet_ledger_entries_immutable() returns trigger
      language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only: % is not allowed', tg_op
          using errcode = 'restrict_violation';
      end;
      $$;
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_update_delete
        before update or delete on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_immutable();
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function wallet_ledger_entries_immutable();
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name  text           not null check (btrim(consumer_name) <> ''),
        message_id     text           not null check (btrim(message_id) <> ''),
        payload_hash   char(64)       not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        received_at    timestamptz(3) not null,
        processed_at   timestamptz(3),
        primary key (consumer_name, message_id)
      );
    `);

    this.addSql(`
      create table outbox_messages (
        id               uuid           primary key,
        sequence         bigint         generated always as identity unique,
        aggregate_id     uuid           not null,
        event_type       text           not null check (btrim(event_type) <> ''),
        payload          jsonb          not null check (jsonb_typeof(payload) = 'object'),
        occurred_at      timestamptz(3) not null,
        attempts         integer        not null default 0 check (attempts >= 0),
        next_attempt_at  timestamptz(3),
        published_at     timestamptz(3),
        constraint outbox_messages_published_check check (published_at is null or next_attempt_at is null)
      );
    `);
    this.addSql(`
      create index outbox_messages_pending_idx
        on outbox_messages (next_attempt_at nulls first, sequence)
        where published_at is null;
    `);
  }

  override down(): void {
    this.addSql('drop table if exists outbox_messages;');
    this.addSql('drop table if exists inbox_messages;');
    this.addSql('drop table if exists wallet_ledger_entries;');
    this.addSql('drop function if exists wallet_ledger_entries_immutable();');
    this.addSql('drop table if exists wager_transactions;');
    this.addSql('drop table if exists wallets;');
  }
}
