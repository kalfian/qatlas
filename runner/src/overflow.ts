// In-page measurement for expect_no_horizontal_scroll (docs/14).
// scanOverflow() is serialised by Playwright and run in the page, so it must be self-contained:
// no imports, no closures over module scope; helpers live inside it. tsconfig has no DOM lib, so the
// few DOM members it touches are typed locally.

interface DomRect {
  left: number
  right: number
  width: number
  height: number
}

interface DomElement {
  tagName: string
  id: string
  parentElement: DomElement | null
  scrollWidth: number
  clientWidth: number
  clientLeft: number
  scrollLeft: number
  getBoundingClientRect(): DomRect
  getAttribute(name: string): string | null
  querySelectorAll(selector: string): Iterable<DomElement>
}

interface DomGlobals {
  document: { scrollingElement: DomElement | null; documentElement: DomElement }
  scrollX: number
  getComputedStyle(el: DomElement): { overflowX: string; visibility: string }
}

export interface ScanArg {
  /** True → the container is the document (scrollingElement); the matched elements are ignored. */
  document: boolean
  tolerancePx: number
  /** Collect offending elements (only on the final, failing probe: it walks every element). */
  withOffenders: boolean
  maxOffenders: number
}

export interface ScanResult {
  /** Number of matched container elements (1 for the document). */
  count: number
  scrollWidth: number
  clientWidth: number
  /** "tag#id.class1.class2 (right edge {n}px)", widest overflow first. */
  offenders: string[]
}

/**
 * Measure the container's scrollWidth/clientWidth and, on request, list visible descendants whose
 * right edge passes the container's visible right edge (+ tolerance). Right edges are in the
 * container's content coordinates (px from its left padding edge, scroll offset removed), so for
 * the document they are px from the page's left edge. Elements clipped by an inner scroll/hidden
 * container are not offenders: they cannot widen the container being checked.
 */
export function scanOverflow(els: unknown[], arg: ScanArg): ScanResult {
  const g = globalThis as unknown as DomGlobals
  const root = arg.document ? (g.document.scrollingElement ?? g.document.documentElement) : (els[0] as DomElement | undefined)
  const count = arg.document ? 1 : els.length
  if (!root || count !== 1) return { count, scrollWidth: 0, clientWidth: 0, offenders: [] }
  const result: ScanResult = { count, scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, offenders: [] }
  if (!arg.withOffenders) return result

  const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
  const describe = (el: DomElement) => {
    const classes = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
    const id = el.id ? `#${trunc(el.id, 40)}` : ''
    const cls = classes.slice(0, 3).map((c) => `.${trunc(c, 30)}`).join('') + (classes.length > 3 ? '…' : '')
    return `${el.tagName.toLowerCase()}${id}${cls}`
  }
  // Memoised "is this element clipped by an ancestor between it and root?" (overflow-x ≠ visible).
  const clipped = new Map<DomElement, boolean>()
  const isClipped = (el: DomElement): boolean => {
    const parent = el.parentElement
    if (!parent || parent === root) return false
    const known = clipped.get(parent)
    if (known !== undefined) return known
    const value = g.getComputedStyle(parent).overflowX !== 'visible' || isClipped(parent)
    clipped.set(parent, value)
    return value
  }

  const edge = arg.document ? -g.scrollX : root.getBoundingClientRect().left + root.clientLeft - root.scrollLeft
  const limit = root.clientWidth + arg.tolerancePx + 0.5 // half a pixel absorbs sub-pixel layout
  const found: { label: string; right: number }[] = []
  // Right edge of every offender, to drop descendants that stick out no further than an offending
  // ancestor (a wide table would otherwise also list its thead, tr, th, …). querySelectorAll walks
  // in document order, so ancestors are seen before their descendants.
  const offenderRight = new Map<DomElement, number>()
  const coveredByAncestor = (el: DomElement, right: number): boolean => {
    for (let p = el.parentElement; p && p !== root; p = p.parentElement) {
      const r = offenderRight.get(p)
      if (r !== undefined) return right <= r + 0.5
    }
    return false
  }
  for (const el of root.querySelectorAll('*')) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    const right = rect.right - edge
    if (right <= limit) continue
    if (g.getComputedStyle(el).visibility === 'hidden' || isClipped(el)) continue
    const covered = coveredByAncestor(el, right)
    offenderRight.set(el, right)
    if (!covered) found.push({ label: describe(el), right })
  }
  // Stable sort: on equal right edges the outer element (document order) comes first.
  found.sort((a, b) => b.right - a.right)
  result.offenders = found.slice(0, arg.maxOffenders).map((f) => `${f.label} (right edge ${Math.round(f.right)}px)`)
  return result
}
