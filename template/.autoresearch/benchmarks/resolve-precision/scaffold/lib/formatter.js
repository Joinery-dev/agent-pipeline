/**
 * Formatter module — number formatting utilities
 */

export function formatAmount(amount) {
  if (amount < 0) return undefined; // BUG: should format negative numbers, not return undefined
  const parts = amount.toFixed(2).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}

export function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}
