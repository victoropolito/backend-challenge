import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { canonicalJson, payloadHash, type CanonicalJsonValue } from '../../../../src/application/shared/payload-hash';

describe('canonicalJson', () => {
  it('serializes scalars like JSON', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson('25.00')).toBe('"25.00"');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(-0)).toBe('0');
  });

  it('sorts object keys and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: 'x', c: null })).toBe('{"a":"x","b":1,"c":null}');
  });

  it('sorts keys recursively, including objects inside arrays', () => {
    const value = { z: { d: 1, c: [{ y: 2, x: 1 }] }, a: [] };
    expect(canonicalJson(value)).toBe('{"a":[],"z":{"c":[{"x":1,"y":2}],"d":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalJson(['b', 'a'])).toBe('["b","a"]');
  });

  it('sorts keys by UTF-16 code unit, not by locale', () => {
    expect(canonicalJson({ b: 1, B: 2, á: 3, a: 4 })).toBe('{"B":2,"a":4,"b":1,"á":3}');
  });

  it('escapes strings and keys exactly as JSON does', () => {
    expect(canonicalJson({ 'k"\n': 'quote " and \\ and \u0001' })).toBe('{"k\\"\\n":"quote \\" and \\\\ and \\u0001"}');
  });

  it('is independent of key insertion order', () => {
    const a = { providerId: 'p', money: { amount: '1.00', currency: 'BRL' }, kind: 'BET' };
    const b = { kind: 'BET', money: { currency: 'BRL', amount: '1.00' }, providerId: 'p' };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('rejects undefined members instead of silently dropping them', () => {
    expect(() => canonicalJson({ a: undefined } as unknown as CanonicalJsonValue)).toThrow(TypeError);
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it('rejects values that are not plain JSON', () => {
    for (const value of [new Date(0), new Map(), 1n, () => 1, Symbol('s'), undefined]) {
      expect(() => canonicalJson(value as unknown as CanonicalJsonValue)).toThrow(TypeError);
    }
  });

  it('accepts objects without prototype', () => {
    const value = Object.assign(Object.create(null) as Record<string, CanonicalJsonValue>, { b: 1, a: 2 });
    expect(canonicalJson(value)).toBe('{"a":2,"b":1}');
  });
});

describe('payloadHash', () => {
  it('is the lowercase hex SHA-256 of the canonical JSON', () => {
    const value = { b: 'é', a: 1 };
    const expected = createHash('sha256').update('{"a":1,"b":"é"}', 'utf8').digest('hex');
    expect(payloadHash(value)).toBe(expected);
    expect(payloadHash(value)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches a known vector', () => {
    expect(payloadHash({})).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  });

  it('is the same for the same content in any key order', () => {
    expect(payloadHash({ a: 1, b: { c: 2, d: 3 } })).toBe(payloadHash({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('differs when any value differs', () => {
    expect(payloadHash({ amount: '25.00' })).not.toBe(payloadHash({ amount: '25.01' }));
    expect(payloadHash({ reference: null })).not.toBe(payloadHash({}));
  });
});
