// [base, per-kg 1-5, per-kg over 5] by country and service
const RATES = {
  US: { standard: [6, 2, 1.5], express: [15, 4, 3] },
  CA: { standard: [12, 3, 2.5], express: [25, 6, 5] },
  MX: { standard: [12, 3, 2.5], express: [25, 6, 5] },
  EU: { standard: [20, 5, 4], express: [40, 8, 7] },
};
const SURCHARGE = { MX: 5 };

function tiered(weightKg, [base, mid, high]) {
  if (weightKg <= 1) return base;
  if (weightKg <= 5) return base + (weightKg - 1) * mid;
  return base + 4 * mid + (weightKg - 5) * high;
}

export function shippingCost(weightKg, country, express, subtotal) {
  if (typeof weightKg !== 'number' || isNaN(weightKg)) throw new TypeError('weightKg must be a number');
  if (weightKg <= 0) throw new RangeError('weightKg must be positive');
  if (typeof subtotal !== 'number' || isNaN(subtotal) || subtotal < 0) {
    throw new RangeError('subtotal must be a non-negative number');
  }
  const rates = RATES[country];
  if (!rates) throw new Error('unsupported country: ' + country);
  let cost = tiered(weightKg, express ? rates.express : rates.standard);
  if (country === 'US' && !express && subtotal >= 100) cost = 0;
  cost += SURCHARGE[country] ?? 0;
  return Math.round(cost * 100) / 100;
}
