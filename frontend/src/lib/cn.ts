/* Single source of truth for conditional / merged className strings.
 *
 * - `clsx` resolves a mix of strings, arrays, and {className: boolean} objects
 *   into a single space-separated class list.
 * - `tailwind-merge` then deduplicates Tailwind utility classes that target
 *   the same property — so `cn("p-2", isLg && "p-4")` correctly outputs
 *   "p-4" without you having to think about ordering or last-wins specificity.
 *
 * Usage convention: every component should compose its className via this
 * helper instead of string concatenation, so override patterns ("base classes
 * here, but consumer can pass extra classes that win") work uniformly.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
