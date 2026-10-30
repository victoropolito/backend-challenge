import { Migration } from '@mikro-orm/migrations';

const LEDGER_CONSISTENCY_WITH_OBSERVED_BALANCE = `
  create or replace function wallet_ledger_entries_consistency() returns trigger
  language plpgsql as $$
  declare
    previous_balance numeric(20, 2);
    transaction_kind text;
    transaction_status text;
    transaction_observed_balance numeric(20, 2);
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

    select kind, status, observed_balance into transaction_kind, transaction_status, transaction_observed_balance
      from wager_transactions where id = new.transaction_id;
    if transaction_kind = 'LOSS' or transaction_status <> 'PROCESSED' then
      raise exception 'violates "wallet_ledger_entries_transaction_check": entry % belongs to a % % transaction',
        new.id, transaction_status, transaction_kind
        using errcode = 'check_violation';
    end if;
    if transaction_observed_balance is distinct from new.balance_after then
      raise exception 'violates "wallet_ledger_entries_observed_balance_check": entry % ends at % but its transaction observed %',
        new.id, new.balance_after, transaction_observed_balance
        using errcode = 'check_violation';
    end if;

    perform assert_wallet_balance_matches_ledger(new.wallet_id);
    return null;
  end;
  $$;
`;

const LEDGER_CONSISTENCY_ORIGINAL = `
  create or replace function wallet_ledger_entries_consistency() returns trigger
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
`;

/** Saldo observado por transação (resposta original do replay), coerente com o status e com o lançamento do ledger. */
export class Migration20261030160000 extends Migration {
  override name = 'Migration20261030160000';

  override up(): void {
    this.addSql('alter table wager_transactions add column observed_balance numeric(20, 2);');

    this.addSql('alter table wager_transactions disable trigger wager_transactions_guard;');
    this.addSql(`
      update wager_transactions t
         set observed_balance = coalesce(
               (select e.balance_after from wallet_ledger_entries e where e.transaction_id = t.id),
               (select e.balance_after from wallet_ledger_entries e
                 where e.wallet_id = t.wallet_id and e.created_at <= t.processed_at
                 order by e.sequence desc limit 1),
               0)
       where t.status = 'PROCESSED';
    `);
    this.addSql('alter table wager_transactions enable trigger wager_transactions_guard;');

    this.addSql(`
      alter table wager_transactions add constraint wager_transactions_observed_balance_check check (
        (observed_balance is null or observed_balance >= 0)
        and (status <> 'PROCESSED' or observed_balance is not null)
        and (status in ('PROCESSED', 'REJECTED') or observed_balance is null)
      );
    `);

    this.addSql(LEDGER_CONSISTENCY_WITH_OBSERVED_BALANCE);
  }

  override down(): void {
    this.addSql(LEDGER_CONSISTENCY_ORIGINAL);
    this.addSql('alter table wager_transactions drop constraint wager_transactions_observed_balance_check;');
    this.addSql('alter table wager_transactions drop column observed_balance;');
  }
}
