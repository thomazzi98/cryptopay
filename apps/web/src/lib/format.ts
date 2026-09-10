/**
 * Formatting rules that must hold everywhere, because inconsistency in a figure reads as a bug.
 *
 * Money never becomes a JavaScript number. An amount arrives as two strings, base units and a
 * display form, and both stay strings: `Number('25000000000000000000')` is already wrong, and it is
 * wrong silently.
 */

/** How many fractional digits it takes for an amount to show that it is there at all. */
function digitsThatShowSomething(whole: string, fraction: string, requested: number): number {
  if (/[1-9]/.test(whole)) {
    return requested;
  }
  const firstSignificant = fraction.search(/[1-9]/);
  if (firstSignificant < 0) {
    return requested;
  }
  return Math.max(requested, firstSignificant + 1);
}

/**
 * Groups the whole part and trims the fractional part to what a person actually reads.
 *
 * A non-zero amount never renders as zero. Two places is right for a six-decimal stablecoin and
 * wrong for an eighteen-decimal currency, where a real payment of 0.004 would otherwise read as
 * `0.00` and tell a merchant no money moved. Where rounding would erase the amount, enough places
 * are kept to reach its first significant digit.
 */
export function formatAmount(display: string, maximumFractionDigits = 2): string {
  const [whole = '0', fraction = ''] = display.split('.', 2);
  const grouped = whole.replaceAll(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (fraction === '') {
    return grouped;
  }
  const digits = digitsThatShowSomething(whole, fraction, maximumFractionDigits);
  const trimmed = fraction.slice(0, digits).padEnd(digits, '0');
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

/**
 * One locale for the whole interface, rather than the viewer's.
 *
 * The copy on these screens is English and cannot be translated, so following the browser's locale
 * produced an interface that was English everywhere except its dates — a payment row reading
 * "há 12 horas" beside an English column header. It also made a screenshot from one machine
 * disagree with the same screen on another, which for an operational tool is worse than a date
 * nobody's locale would have chosen.
 *
 * The clock is still the viewer's. Only the words are fixed.
 */
const INTERFACE_LOCALE = 'en-GB';

export function formatTimestamp(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleString(INTERFACE_LOCALE, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatShortTimestamp(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleString(INTERFACE_LOCALE, {
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
  const formatter = new Intl.RelativeTimeFormat(INTERFACE_LOCALE, { numeric: 'auto' });
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
