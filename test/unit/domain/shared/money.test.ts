import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from '../../../../src/domain/shared/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

describe('Money', () => {
  describe('from', () => {
    it.each([
      ['25.00', '25.00'],
      ['25.5', '25.50'],
      ['25', '25.00'],
      ['0', '0.00'],
      ['0.01', '0.01'],
      ['999999999999999999.99', '999999999999999999.99'],
    ])('normalizes %p to fixed scale %p', (input, expected) => {
      expect(brl(input).toJSON()).toEqual({ amount: expected, currency: 'BRL' });
    });

    it.each([
      ['empty string', ''],
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
      ['-Infinity', '-Infinity'],
      ['scientific notation', '1e3'],
      ['scientific notation with fraction', '2.5E2'],
      ['more than 2 decimal places', '25.001'],
      ['trailing zero beyond scale', '25.000'],
      ['negative value', '-25.00'],
      ['explicit plus sign', '+25.00'],
      ['leading zeros', '0025.00'],
      ['missing integer part', '.50'],
      ['missing fraction digits', '25.'],
      ['comma as decimal separator', '25,00'],
      ['thousands separator', '1,000.00'],
      ['surrounding whitespace', ' 25.00 '],
      ['hexadecimal', '0x10'],
      ['more than 18 integer digits', '1000000000000000000.00'],
    ])('rejects %s', (_, amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    });

    it('rejects non-string amounts', () => {
      expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from(null as unknown as { amount: string; currency: string })).toThrow(InvalidMoneyError);
    });

    it.each(['', 'brl', 'BR', 'BRLL', 'R$'])('rejects invalid currency %p', (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    });
  });

  describe('rehydrate', () => {
    it('accepts negative values', () => {
      expect(Money.rehydrate({ amount: '-5.50', currency: 'BRL' }).toJSON()).toEqual({ amount: '-5.50', currency: 'BRL' });
    });

    it('normalizes negative zero', () => {
      const money = Money.rehydrate({ amount: '-0.00', currency: 'BRL' });
      expect(money.toJSON().amount).toBe('0.00');
      expect(money.isNegative()).toBe(false);
    });

    it.each(['NaN', '1e3', '1.001', '--1.00', ''])('still rejects malformed amount %p', (amount) => {
      expect(() => Money.rehydrate({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
    });
  });

  describe('arithmetic', () => {
    it('adds and subtracts exactly, without floating-point drift', () => {
      expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
      expect(brl('1.00').subtract(brl('0.99')).toJSON().amount).toBe('0.01');
      expect(brl('999999999999999999.98').add(brl('0.01')).toJSON().amount).toBe('999999999999999999.99');
    });

    it('can produce negative results', () => {
      const result = brl('20.00').subtract(brl('80.00'));
      expect(result.toJSON().amount).toBe('-60.00');
      expect(result.isNegative()).toBe(true);
    });

    it('negates', () => {
      expect(brl('25.00').negate().toJSON().amount).toBe('-25.00');
      expect(brl('25.00').negate().negate().equals(brl('25.00'))).toBe(true);
      expect(Money.zero('BRL').negate().equals(Money.zero('BRL'))).toBe(true);
    });

    it('is immutable', () => {
      const a = brl('10.00');
      const b = brl('5.00');
      const sum = a.add(b);
      a.subtract(b);
      a.negate();

      expect(a.toJSON().amount).toBe('10.00');
      expect(b.toJSON().amount).toBe('5.00');
      expect(sum).not.toBe(a);
    });

    it('rejects results beyond the supported magnitude', () => {
      expect(() => brl('999999999999999999.99').add(brl('0.01'))).toThrow(InvalidMoneyError);
    });
  });

  describe('comparisons', () => {
    it('reports sign', () => {
      expect(Money.zero('BRL').isZero()).toBe(true);
      expect(Money.zero('BRL').isPositive()).toBe(false);
      expect(brl('0.01').isPositive()).toBe(true);
      expect(brl('0.01').negate().isNegative()).toBe(true);
    });

    it('compares values of the same currency', () => {
      expect(brl('9.99').isLessThan(brl('10.00'))).toBe(true);
      expect(brl('10.00').isLessThan(brl('10.00'))).toBe(false);
      expect(brl('10.01').isGreaterThan(brl('10.00'))).toBe(true);
    });

    it('treats equal amounts with different input forms as equal', () => {
      expect(brl('25').equals(brl('25.00'))).toBe(true);
    });

    it('does not consider different currencies equal', () => {
      expect(brl('25.00').equals(usd('25.00'))).toBe(false);
    });
  });

  describe('currency conflicts', () => {
    it.each([
      ['add', (a: Money, b: Money) => a.add(b)],
      ['subtract', (a: Money, b: Money) => a.subtract(b)],
      ['isLessThan', (a: Money, b: Money) => a.isLessThan(b)],
      ['isGreaterThan', (a: Money, b: Money) => a.isGreaterThan(b)],
    ])('%s throws CurrencyMismatchError', (_, operation) => {
      expect(() => operation(brl('1.00'), usd('1.00'))).toThrow(CurrencyMismatchError);
    });

    it('exposes a stable error code', () => {
      try {
        brl('1.00').add(usd('1.00'));
        throw new Error('expected to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(CurrencyMismatchError);
        expect((error as CurrencyMismatchError).code).toBe('CURRENCY_MISMATCH');
      }
    });
  });

  describe('serialization', () => {
    it('round-trips through JSON', () => {
      const money = brl('975.00');
      const json = JSON.parse(JSON.stringify(money));
      expect(json).toEqual({ amount: '975.00', currency: 'BRL' });
      expect(Money.from(json).equals(money)).toBe(true);
    });

    it('formats as string with currency', () => {
      expect(brl('25.5').toString()).toBe('25.50 BRL');
    });
  });
});
