import { createHash } from 'node:crypto';

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

/** Serializa `value` como JSON canônico: sem espaços, chaves de objeto ordenadas por code unit UTF-16 (RFC 8785). */
export function canonicalJson(value: CanonicalJsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot canonicalize non-finite number ${value}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: CanonicalJsonValue) => canonicalJson(item)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const members = Object.keys(value)
      .sort()
      .map((key) => {
        const member = value[key];
        if (member === undefined) {
          throw new TypeError(`Cannot canonicalize undefined value at key "${key}"`);
        }
        return `${JSON.stringify(key)}:${canonicalJson(member)}`;
      });
    return `{${members.join(',')}}`;
  }
  throw new TypeError(`Cannot canonicalize value of type ${typeof value}`);
}

/** SHA-256 (hex minúsculo) do JSON canônico de `value`. */
export function payloadHash(value: CanonicalJsonValue): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function isPlainObject(value: unknown): value is { readonly [key: string]: CanonicalJsonValue } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
