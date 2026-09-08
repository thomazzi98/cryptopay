import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merges class names so a caller's utility wins over a component's default rather than both landing
 * in the class list and the cascade deciding at random.
 */
export function classNames(...values: ClassValue[]): string {
  return twMerge(clsx(values));
}
