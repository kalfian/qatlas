/** Bentuk terjemahan: kunci sama persis dengan bahasa Inggris, semua daun string. */
export type Translation<T> = {
  [K in keyof T]: T[K] extends string ? string : Translation<T[K]>
}

export type Language = 'en' | 'id'
export const LANGUAGES: { value: Language; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'id', label: 'Bahasa Indonesia' },
]
