import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge only knows Tailwind's own size names, so it read `text-tui-sm`
 * as a colour and dropped it whenever a real colour came after it: every
 * `cn('text-tui-sm text-tui-faint')` rendered at the body size. Naming the
 * interface's type sizes keeps size and colour in their own groups.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['tui', 'tui-sm', 'tui-lg'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
