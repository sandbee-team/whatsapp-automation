import { describe, expect, it } from 'vitest';
import { InvalidRupeeAmountError, paiseToRupees, rupeesToPaise } from './money.js';

describe('rupeesToPaise', () => {
  it('converts a two-decimal rupee amount to exact paise', () => {
    expect(rupeesToPaise('12.34')).toBe(1234);
  });

  it('converts a whole-rupee amount to exact paise', () => {
    expect(rupeesToPaise('12')).toBe(1200);
  });

  it('converts a one-decimal rupee amount to exact paise', () => {
    expect(rupeesToPaise('12.3')).toBe(1230);
  });

  it('converts a large amount to exact paise', () => {
    expect(rupeesToPaise('1000.50')).toBe(100_050);
  });

  it('throws on more than two decimal places', () => {
    expect(() => rupeesToPaise('12.345')).toThrow(InvalidRupeeAmountError);
  });

  it('throws on a negative amount', () => {
    expect(() => rupeesToPaise('-12.34')).toThrow(InvalidRupeeAmountError);
  });

  it('throws on non-numeric input', () => {
    expect(() => rupeesToPaise('abc')).toThrow(InvalidRupeeAmountError);
  });
});

describe('paiseToRupees', () => {
  it('formats a positive amount with two decimal places', () => {
    expect(paiseToRupees(30045)).toBe('₹300.45');
  });

  it('formats a negative amount with the sign before the currency symbol', () => {
    expect(paiseToRupees(-5)).toBe('-₹0.05');
  });

  it('formats zero as ₹0.00', () => {
    expect(paiseToRupees(0)).toBe('₹0.00');
  });
});
