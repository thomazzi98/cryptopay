/**
 * Formatting rules that must hold everywhere, because inconsistency in a figure reads as a bug.
 *
 * Money never becomes a JavaScript number. An amount arrives as two strings, base units and a
 * display form, and both stay strings: `Number('25000000000000000000')` is already wrong, and it is
 * wrong silently.
 */

/** Groups the whole part and trims the fractional part to what a person actually reads. */
export function formatAmount(display: string, maximumFractionDigits = 2): string {
  const [whole = '0', fraction = ''] = display.split('.', 2);
  const grouped = whole.replaceAll(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (fraction === '') {
    return grouped;
  }
  const trimmed = fraction.slice(0, maximumFractionDigits).padEnd(maximumFractionDigits, '0');
  return `${grouped}.${trimmed}`;
}

/** The exact figure, for a tooltip or a details row. Never rounded, because it is the real value. */
export function formatExactAmount(display: string): string {
  const [whole = '0', fraction] = display.split('.', 2);
  const grouped = whole.replaceAll(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/**
 * The middle of a hash or an address, elided. Both ends are kept because both ends are what someone
 * compares against a block explorer; eliding one end makes the comparison impossible.
 */
export function truncateReference(value: string, lead = 6, tail = 4): string {
  if (value.length <= lead + tail + 1) {
    return value;
  }
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export function formatTimestamp(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatShortTimestamp(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const RELATIVE_UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = Object.freeze([
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.345],
  ['month', 12],
  ['year', Infinity],
]);

/** `now` is passed in so a server render and the hydration that follows cannot disagree. */
export function formatRelative(isoTimestamp: string, now: number): string {
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  let delta = (new Date(isoTimestamp).getTime() - now) / 1000;

  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(delta) < size) {
      return formatter.format(Math.round(delta), unit);
    }
    delta /= size;
  }
  return formatter.format(Math.round(delta), 'year');
}

/** Whole seconds until a deadline, floored at zero: a negative countdown reads as a bug. */
export function secondsUntil(isoTimestamp: string, now: number): number {
  return Math.max(0, Math.floor((new Date(isoTimestamp).getTime() - now) / 1000));
}

export function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString()}:${seconds.toString().padStart(2, '0')}`;
}
