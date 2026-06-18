import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Standard shadcn class combiner: clsx for conditional classes, tailwind-merge
// to dedupe conflicting Tailwind utilities (last one wins).
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
