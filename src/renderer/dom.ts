export function requireElement<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} not found`);
  return el as unknown as T;
}

export function formatHashrate(value: number, unit: string): string {
  if (!Number.isFinite(value) || value <= 0) return `0 ${unit}`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} M${unit}`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)} k${unit}`;
  return `${value.toFixed(1)} ${unit}`;
}

export function formatInteger(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Math.round(value).toLocaleString('en-US');
}
