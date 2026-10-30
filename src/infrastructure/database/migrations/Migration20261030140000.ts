import { Migration } from '@mikro-orm/migrations';

/** Reforça no banco: reversão única por referência, imutabilidade de wallets/transações e saldo = ledger ao fim de cada transação SQL. */
export class Migration20261030140000 extends Migration {
  override name = 'Migration20261030140000';

  override up(): void {
    this.addSql('drop index wager_transactions_single_reversal_idx;');
    this.addSql(`
      create unique index wager_transactions_single_reversal_idx
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
    `);

    this.addSql(`
      create function wallets_guard() returns trigger
      language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wallets rows cannot be deleted (wallet %)', old.id
            using errcode = 'restrict_violation';
        end if;
        if (new.id, new.player_id, new.currency, new.created_at)
           is distinct from (old.id, old.player_id, old.currency, old.created_at) then
          raise exception 'wallet % identity columns are immutable', old.id
            using errcode = 'restrict_violation';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger wallets_guard
        before update or delete on wallets
        for each row execute function wallets_guard();
    `);

    this.addSql(`
      create function wager_transactions_guard() returns trigger
      language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager_transactions rows cannot be deleted (transaction %)', old.id
            using errcode = 'restrict_violation';
        end if;
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is % and cannot change', old.id, old.status
            using errcode = 'restrict_violation';
        end if;
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
            new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
            old.reference_external_transaction_id, old.created_at) then
          raise exception 'wager transaction % request columns are immutable', old.id
            using errcode = 'restrict_violation';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger wager_transactions_guard
        before update or delete on wager_transactions
        for each row execute function wager_transactions_guard();
    `);

    this.addSql(`
      create function assert_wallet_balance_matches_ledger(target_wallet_id uuid) returns void
      language plpgsql as $$
      declare
        stored_balance numeric(20, 2);
        ledger_balance numeric(20, 2);
      begin
        select balance into stored_balance from wallets where id = target_wallet_id;
        select balance_after into ledger_balance
          from wallet_ledger_entries
          where wallet_id = target_wallet_id
          order by sequence desc
          limit 1;
        if stored_balance is distinct from coalesce(ledger_balance, 0) then
          raise exception 'violates "wallet_balance_ledger_check": wallet % balance % differs from ledger balance %',
            target_wallet_id, stored_balance, coalesce(ledger_balance, 0)
            using errcode = 'check_violation';
        end if;
      end;
      $$;
    `);

    this.addSql(`
      create function wallets_balance_matches_ledger() returns trigger
      language plpgsql as $$
      begin
        perform assert_wallet_balance_matches_ledger(new.id);
        return null;
      end;
      $$;
    `);
    this.addSql(`
      create constraint trigger wallets_balance_matches_ledger
        after insert or update on wallets
        deferrable initially deferred
        for each row execute function wallets_balance_matches_ledger();
    `);

    this.addSql(`
      create function wallet_ledger_entries_consistency() returns trigger
      language plpgsql as $$
      declare
        previous_balance numeric(20, 2);
        transaction_kind text;
        transaction_status text;
      begin
        select balance_after into previous_balance
          from wallet_ledger_entries
          where wallet_id = new.wallet_id and sequence < new.sequence
          order by sequence desc
          limit 1;
        if new.balance_before <> coalesce(previous_balance, 0) then
          raise exception 'violates "wallet_ledger_entries_chain_check": entry % starts at % but previous balance is %',
            new.id, new.balance_before, coalesce(previous_balance, 0)
            using errcode = 'check_violation';
        end if;

        select kind, status into transaction_kind, transaction_status
          from wager_transactions where id = new.transaction_id;
        if transaction_kind = 'LOSS' or transaction_status <> 'PROCESSED' then
          raise exception 'violates "wallet_ledger_entries_transaction_check": entry % belongs to a % % transaction',
            new.id, transaction_status, transaction_kind
            using errcode = 'check_violation';
        end if;

        perform assert_wallet_balance_matches_ledger(new.wallet_id);
        return null;
      end;
      $$;
    `);
    this.addSql(`
      create constraint trigger wallet_ledger_entries_consistency
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function wallet_ledger_entries_consistency();
    `);
  }

  override down(): void {
    this.addSql('drop trigger if exists wallet_ledger_entries_consistency on wallet_ledger_entries;');
    this.addSql('drop function if exists wallet_ledger_entries_consistency();');
    this.addSql('drop trigger if exists wallets_balance_matches_ledger on wallets;');
    this.addSql('drop function if exists wallets_balance_matches_ledger();');
    this.addSql('drop function if exists assert_wallet_balance_matches_ledger(uuid);');
    this.addSql('drop trigger if exists wager_transactions_guard on wager_transactions;');
    this.addSql('drop function if exists wager_transactions_guard();');
    this.addSql('drop trigger if exists wallets_guard on wallets;');
    this.addSql('drop function if exists wallets_guard();');
    this.addSql('drop index wager_transactions_single_reversal_idx;');
    this.addSql(`
      create unique index wager_transactions_single_reversal_idx
        on wager_transactions (reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
    `);
  }
}
