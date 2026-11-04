import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function uid(prefix = ''): string {
  const rnd = crypto.getRandomValues(new Uint8Array(8))
  return prefix + Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function pluralize(n: number, word: string): string {
  return `${n} ${word}`
}
