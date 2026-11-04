// Small JSONPath subset: $  .key  ['key']  ["key"]  [0]  [-1]   e.g. $.data[0].id, $['x-y'].z
// No wildcards, filters or recursive descent.

export type PathSegment = string | number

export function parseJsonPath(path: string): PathSegment[] {
  let p = path.trim()
  if (p.startsWith('$')) p = p.slice(1)
  else if (p && !p.startsWith('.') && !p.startsWith('[')) p = '.' + p // tolerate "data.id"
  const segs: PathSegment[] = []
  let i = 0
  while (i < p.length) {
    const c = p[i]
    if (c === '.') {
      const m = /^\.([^.[\]]+)/.exec(p.slice(i))
      if (!m) throw new Error(`Invalid JSONPath "${path}" near "${p.slice(i)}"`)
      segs.push(m[1])
      i += m[0].length
    } else if (c === '[') {
      const rest = p.slice(i)
      const idx = /^\[\s*(-?\d+)\s*\]/.exec(rest)
      const quoted = /^\[\s*(['"])(.*?)\1\s*\]/.exec(rest)
      if (idx) {
        segs.push(Number(idx[1]))
        i += idx[0].length
      } else if (quoted) {
        segs.push(quoted[2])
        i += quoted[0].length
      } else {
        throw new Error(`Invalid JSONPath "${path}" near "${rest}" (supported: .key, ['key'], [n])`)
      }
    } else {
      throw new Error(`Invalid JSONPath "${path}" near "${p.slice(i)}"`)
    }
  }
  return segs
}

export interface PathResult {
  found: boolean
  value: unknown
}

export function evalJsonPath(root: unknown, path: string): PathResult {
  let cur: unknown = root
  for (const seg of parseJsonPath(path)) {
    if (typeof seg === 'number') {
      if (!Array.isArray(cur)) return { found: false, value: undefined }
      const i = seg < 0 ? cur.length + seg : seg
      if (i < 0 || i >= cur.length) return { found: false, value: undefined }
      cur = cur[i]
    } else {
      if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !(seg in (cur as object))) {
        return { found: false, value: undefined }
      }
      cur = (cur as Record<string, unknown>)[seg]
    }
  }
  return { found: true, value: cur }
}
