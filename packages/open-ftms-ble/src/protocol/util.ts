/** Object with one boolean per named bit. */
export type FlagSet<N extends string> = { readonly [K in N]: boolean };

/** Decodes a bit field; `names[i]` is the name of bit `i`. */
export function decodeFlags<const N extends readonly string[]>(
  value: number,
  names: N,
): FlagSet<N[number]> {
  const result: Record<string, boolean> = {};
  names.forEach((name, bit) => {
    result[name] = ((value >>> bit) & 1) === 1;
  });
  return result as FlagSet<N[number]>;
}

/** Returns only the bits at positions `>= definedBitCount` (the reserved ones). */
export function reservedBits(value: number, definedBitCount: number): number {
  if (definedBitCount >= 32) return 0;
  return ((value >>> definedBitCount) << definedBitCount) >>> 0;
}

/** Builds a reverse lookup `code → name` for a `name → code` table. */
export function invert<T extends Record<string, number>>(table: T): ReadonlyMap<number, keyof T & string> {
  return new Map(Object.entries(table).map(([name, code]) => [code, name as keyof T & string]));
}

/** Assigns `value` only if it is defined, so absent fields stay absent. */
export function put<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}
