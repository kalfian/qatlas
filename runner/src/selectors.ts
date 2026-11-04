import type { Locator, Page } from 'playwright'
import { StepFailure } from './errors.js'

export interface ResolvedLocator {
  locator: Locator
  /** Human/code-like description used in messages, e.g. getByTestId('grand-total'). */
  describe: string
}

type AriaRole = Parameters<Page['getByRole']>[0]

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/** `"Exact text"` (double quotes) means exact match, otherwise substring/case-insensitive like Playwright. */
function textArg(raw: string): { text: string; exact: boolean } {
  const t = raw.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return { text: t.slice(1, -1), exact: true }
  return { text: t, exact: false }
}

const optsDesc = (exact: boolean) => (exact ? ', { exact: true }' : '')

/**
 * Map a DSL selector to a Playwright locator (docs/04):
 *   role=button[name='Masuk'] → getByRole('button', { name: 'Masuk' })
 *   label=Email → getByLabel('Email'), placeholder=… → getByPlaceholder, testid=… → getByTestId, text=… → getByText
 *   anything else (#id, .btn, xpath=…, //…) → page.locator(…)
 */
export function resolveSelector(page: Page, selector: unknown): ResolvedLocator {
  if (typeof selector !== 'string' || selector.trim() === '') throw new StepFailure('Step has no selector')
  const sel = selector.trim()
  const m = /^(role|label|placeholder|testid|text)=([\s\S]*)$/.exec(sel)
  if (!m) return { locator: page.locator(sel), describe: `locator(${q(sel)})` }
  const [, kind, rest] = m
  switch (kind) {
    case 'role': {
      const rm = /^([a-z]+)\s*(?:\[\s*name\s*=\s*(['"])([\s\S]*?)\2\s*(i|s)?\s*\])?\s*$/i.exec(rest.trim())
      if (!rm) throw new StepFailure(`Invalid role selector "${sel}" (expected role=<role> or role=<role>[name='…'])`)
      const role = rm[1].toLowerCase() as AriaRole
      const name = rm[3]
      const exact = rm[4] === 's'
      if (name === undefined) return { locator: page.getByRole(role), describe: `getByRole(${q(role)})` }
      return {
        locator: page.getByRole(role, { name, exact }),
        describe: `getByRole(${q(role)}, { name: ${q(name)}${exact ? ', exact: true' : ''} })`,
      }
    }
    case 'label': {
      const { text, exact } = textArg(rest)
      return { locator: page.getByLabel(text, { exact }), describe: `getByLabel(${q(text)}${optsDesc(exact)})` }
    }
    case 'placeholder': {
      const { text, exact } = textArg(rest)
      return { locator: page.getByPlaceholder(text, { exact }), describe: `getByPlaceholder(${q(text)}${optsDesc(exact)})` }
    }
    case 'testid': {
      const id = rest.trim()
      return { locator: page.getByTestId(id), describe: `getByTestId(${q(id)})` }
    }
    default: {
      const { text, exact } = textArg(rest)
      return { locator: page.getByText(text, { exact }), describe: `getByText(${q(text)}${optsDesc(exact)})` }
    }
  }
}
