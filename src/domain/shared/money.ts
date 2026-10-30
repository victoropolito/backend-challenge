import { DomainError } from './domain-error';

/** Representação serializável de `Money` usada nos contratos (HTTP, eventos, persistência). */
export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

const SCALE = 2;
const MINOR_PER_UNIT = 10n ** BigInt(SCALE);
const MAX_INTEGER_DIGITS = 18;
const MAX_ABS_MINOR = 10n ** BigInt(MAX_INTEGER_DIGITS + SCALE);

const UNSIGNED_AMOUNT = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;
const SIGNED_AMOUNT = /^(-)?(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;

/** Valor monetário imutável com escala fixa de 2 casas, armazenado como inteiro de unidades menores. */
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {}

  /** Cria a partir de um contrato de entrada: exige string decimal não negativa com até 2 casas. */
  static from(props: MoneyProps): Money {
    const { amount, currency } = Money.assertProps(props);
    const match = UNSIGNED_AMOUNT.exec(amount);
    if (!match) {
      throw new InvalidMoneyError(`Invalid amount "${amount}": expected a non-negative decimal with up to ${SCALE} places`);
    }
    return Money.of(Money.toMinor(false, match[1], match[2]), currency);
  }

  /** Reconstrói a partir de valor já persistido ou calculado; aceita valores negativos. */
  static rehydrate(props: MoneyProps): Money {
    const { amount, currency } = Money.assertProps(props);
    const match = SIGNED_AMOUNT.exec(amount);
    if (!match) {
      throw new InvalidMoneyError(`Invalid amount "${amount}": expected a decimal with up to ${SCALE} places`);
    }
    return Money.of(Money.toMinor(match[1] === '-', match[2], match[3]), currency);
  }

  static zero(currency: string): Money {
    return Money.of(0n, Money.assertCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return Money.of(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor > other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toJSON(): MoneyProps {
    return { amount: this.formatAmount(), currency: this.currency };
  }

  toString(): string {
    return `${this.formatAmount()} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private formatAmount(): string {
    const abs = this.minor < 0n ? -this.minor : this.minor;
    const units = abs / MINOR_PER_UNIT;
    const fraction = (abs % MINOR_PER_UNIT).toString().padStart(SCALE, '0');
    return `${this.minor < 0n ? '-' : ''}${units}.${fraction}`;
  }

  private static of(minor: bigint, currency: string): Money {
    if (minor >= MAX_ABS_MINOR || minor <= -MAX_ABS_MINOR) {
      throw new InvalidMoneyError(`Amount exceeds ${MAX_INTEGER_DIGITS} integer digits`);
    }
    return new Money(minor, currency);
  }

  private static toMinor(negative: boolean, units: string | undefined, fraction: string | undefined): bigint {
    const minor = BigInt(units ?? '0') * MINOR_PER_UNIT + BigInt((fraction ?? '').padEnd(SCALE, '0'));
    return negative ? -minor : minor;
  }

  private static assertProps(props: unknown): MoneyProps {
    if (typeof props !== 'object' || props === null) {
      throw new InvalidMoneyError('Money must be an object with amount and currency');
    }
    const { amount, currency } = props as Record<string, unknown>;
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('Amount must be a decimal string');
    }
    return { amount, currency: Money.assertCurrency(currency) };
  }

  private static assertCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_CODE.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency "${String(currency)}": expected an ISO-4217 code`);
    }
    return currency;
  }
}
