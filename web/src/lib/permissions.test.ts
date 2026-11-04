import { describe, expect, it } from 'vitest'
import { can } from './permissions'

describe('can (RBAC docs/05)', () => {
  it('viewer hanya bisa melihat', () => {
    expect(can('viewer', 'view')).toBe(true)
    expect(can('viewer', 'run')).toBe(false)
    expect(can('viewer', 'edit_tests')).toBe(false)
  })
  it('editor bisa edit, run, kerjakan manual, tapi tidak kelola environment/member', () => {
    expect(can('editor', 'edit_tests')).toBe(true)
    expect(can('editor', 'execute_manual')).toBe(true)
    expect(can('editor', 'manage_environments')).toBe(false)
    expect(can('editor', 'cancel_any_run')).toBe(false)
  })
  it('maintainer dan admin sistem punya akses penuh', () => {
    expect(can('maintainer', 'manage_members')).toBe(true)
    expect(can(null, 'manage_settings', 'admin')).toBe(true)
    expect(can(null, 'view', 'member')).toBe(false)
  })
})
