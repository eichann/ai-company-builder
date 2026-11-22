import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// tailwind-merge must know the design tokens' scales (design-system.md): without them it reads
// `text-small` as a text colour and drops it next to `text-success-text`, so a badge lost its size.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['caption', 'small', 'body', 'title', 'heading', 'page'] }],
      'font-weight': [{ font: ['strong'] }],
      rounded: [{ rounded: ['small', 'control', 'card'] }],
      shadow: [{ shadow: ['card', 'pop', 'dialog'] }],
      p: [{ p: ['dialog', 'card', 'callout', 'menu'] }],
      z: [{ z: ['overlay', 'dialog', 'menu', 'toast'] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
