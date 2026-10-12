// Exact arithmetic for the rule checks (docs/FIN_BUILD_PLAN.md F4). Pure.
//
// ── CENTS AS BIGINT, NEVER A NUMBER ─────────────────────────────────────────
//
// A check says "GST is wrong" or "CPF is wrong" TO THE CENT, so it must not be
// wrong itself by a rounding error nobody can see: in floating point 0.1 + 0.2
// is not 0.3, and a finding raised on that is one people learn to ignore. So an
// amount (a decimal string, as everywhere in this product) becomes integer
// CENTS as a BigInt, a rate (a decimal string in PERCENT, "9" or "15.5")
// becomes an exact fraction, and every product is rounded once, on purpose,
// in a named direction. No `number` ever holds money here.

/** An amount in whole cents. */
export type Cents = bigint;

const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * A decimal string as cents, or null when it is not a decimal, or when it
 * carries a non-zero digit past the second place: such a value cannot be
 * compared to the cent, and guessing which way it rounds would be the check
 * inventing a figure. Trailing zeros are fine ("46.000", "7400").
 */
export function toCents(value: string | null): Cents | null {
  if (value === null) return null;
  const m = DECIMAL.exec(value.trim());
  if (m === null) return null;
  const negative = m[1] === "-";
  const whole = m[2] ?? "0";
  const fraction = m[3] ?? "";
  if (/[1-9]/.test(fraction.slice(2))) return null;
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
  return negative ? -cents : cents;
}

/** Cents as the product's decimal string, always two places: "46.00", "-3488.00". */
export function fromCents(cents: Cents): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const fraction = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${(abs / 100n).toString()}.${fraction}`;
}

/** A percentage, exactly: `units / 10^scale` percent. "15.5" is 155 at scale 1. */
export interface Rate {
  readonly units: bigint;
  readonly scale: number;
}

/** A non-negative decimal string in percent as a `Rate`, or null. */
export function toRate(percent: string): Rate | null {
  const m = DECIMAL.exec(percent.trim());
  if (m === null || m[1] === "-") return null;
  const fraction = (m[3] ?? "").replace(/0+$/, "");
  return { units: BigInt(`${m[2] ?? "0"}${fraction}`), scale: fraction.length };
}

/** The rate back as a percent string, as short as it can be: "9", "15.5". */
export function rateText(rate: Rate): string {
  if (rate.scale === 0) return rate.units.toString();
  const digits = rate.units.toString().padStart(rate.scale + 1, "0");
  const whole = digits.slice(0, digits.length - rate.scale);
  const fraction = digits.slice(digits.length - rate.scale).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

function atScale(rate: Rate, scale: number): bigint {
  return rate.units * 10n ** BigInt(scale - rate.scale);
}

export function sameRate(a: Rate, b: Rate): boolean {
  const scale = Math.max(a.scale, b.scale);
  return atScale(a, scale) === atScale(b, scale);
}

export function addRates(a: Rate, b: Rate): Rate {
  const scale = Math.max(a.scale, b.scale);
  return { units: atScale(a, scale) + atScale(b, scale), scale };
}

/** How a product is brought back to whole units. */
export type Rounding = "half_away_from_zero" | "down";

/** `n / d` for a positive `d`, rounded as asked. `down` is toward minus
 *  infinity, which is "rounded down" for the positive amounts it is used on. */
export function divide(n: bigint, d: bigint, rounding: Rounding): bigint {
  if (d <= 0n) throw new RangeError(`divide needs a positive divisor, not ${d.toString()}`);
  if (rounding === "down") {
    return n >= 0n ? n / d : -((-n + d - 1n) / d);
  }
  const magnitude = ((n < 0n ? -n : n) * 2n + d) / (2n * d);
  return n < 0n ? -magnitude : magnitude;
}

/** `rate` percent of an amount, in cents, rounded to the cent. */
export function percentOf(amount: Cents, rate: Rate, rounding: Rounding): Cents {
  return divide(amount * rate.units, 100n * 10n ** BigInt(rate.scale), rounding);
}

/** `rate` percent of an amount, rounded to the whole DOLLAR, returned in cents
 *  (CPF's rule: the total to the nearest dollar, the employee's share down). */
export function percentOfInDollars(amount: Cents, rate: Rate, rounding: Rounding): Cents {
  return divide(amount * rate.units, 100n * 100n * 10n ** BigInt(rate.scale), rounding) * 100n;
}

/**
 * Whether `part` is `rate` percent of `base` once the implied rate is rounded
 * to a hundredth of a percent. For a SUMMARY of many sales (a day's POS), whose
 * GST is the sum of each sale's rounded GST and so drifts from the total's by
 * a few cents: 9% charged reads as 9.00% and 8% as 8.00%, which is the
 * difference the check exists to see.
 */
export function impliedRateMatches(part: Cents, base: Cents, rate: Rate): boolean {
  if (base === 0n) return part === 0n;
  // |part / base * 100 - rate| <= 0.005, multiplied through by
  // 200 * |base| * 10^scale so that nothing is divided.
  const s = 10n ** BigInt(rate.scale);
  const diff = part * 100n * s - rate.units * base;
  const magnitude = diff < 0n ? -diff : diff;
  return magnitude * 200n <= (base < 0n ? -base : base) * s;
}
