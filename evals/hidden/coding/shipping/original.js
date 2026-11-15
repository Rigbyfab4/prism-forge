// Shipping cost in USD for an order.
// weightKg: number > 0, country: 'US' | 'CA' | 'MX' | 'EU', express: boolean,
// subtotal: order value in USD (number >= 0)
export function shippingCost(weightKg, country, express, subtotal) {
  if (typeof weightKg !== 'number' || isNaN(weightKg)) {
    throw new TypeError('weightKg must be a number');
  }
  if (weightKg <= 0) {
    throw new RangeError('weightKg must be positive');
  }
  if (typeof subtotal !== 'number' || isNaN(subtotal) || subtotal < 0) {
    throw new RangeError('subtotal must be a non-negative number');
  }
  var cost = 0;
  if (country === 'US') {
    if (express) {
      if (weightKg <= 1) {
        cost = 15;
      } else {
        if (weightKg <= 5) {
          cost = 15 + (weightKg - 1) * 4;
        } else {
          cost = 15 + 4 * 4 + (weightKg - 5) * 3;
        }
      }
    } else {
      if (weightKg <= 1) {
        cost = 6;
      } else {
        if (weightKg <= 5) {
          cost = 6 + (weightKg - 1) * 2;
        } else {
          cost = 6 + 4 * 2 + (weightKg - 5) * 1.5;
        }
      }
      if (subtotal >= 100) {
        cost = 0;
      }
    }
  } else if (country === 'CA' || country === 'MX') {
    if (express) {
      if (weightKg <= 1) {
        cost = 25;
      } else {
        if (weightKg <= 5) {
          cost = 25 + (weightKg - 1) * 6;
        } else {
          cost = 25 + 4 * 6 + (weightKg - 5) * 5;
        }
      }
    } else {
      if (weightKg <= 1) {
        cost = 12;
      } else {
        if (weightKg <= 5) {
          cost = 12 + (weightKg - 1) * 3;
        } else {
          cost = 12 + 4 * 3 + (weightKg - 5) * 2.5;
        }
      }
    }
    if (country === 'MX') {
      cost = cost + 5;
    }
  } else if (country === 'EU') {
    if (express) {
      if (weightKg <= 1) {
        cost = 40;
      } else {
        if (weightKg <= 5) {
          cost = 40 + (weightKg - 1) * 8;
        } else {
          cost = 40 + 4 * 8 + (weightKg - 5) * 7;
        }
      }
    } else {
      if (weightKg <= 1) {
        cost = 20;
      } else {
        if (weightKg <= 5) {
          cost = 20 + (weightKg - 1) * 5;
        } else {
          cost = 20 + 4 * 5 + (weightKg - 5) * 4;
        }
      }
    }
  } else {
    throw new Error('unsupported country: ' + country);
  }
  return Math.round(cost * 100) / 100;
}
