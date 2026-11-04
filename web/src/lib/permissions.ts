import type { ProjectRole, SystemRole } from '@/api/types'
import { lazyLabels } from '@/lib/i18n-labels'

/**
 * Matriks RBAC (docs/05-auth-and-access.md). Dipakai UI (sembunyikan aksi) dan mock API (403).
 */
export type ProjectAction =
  | 'view'
  | 'edit_tests'
  | 'run'
  | 'cancel_own_run'
  | 'cancel_any_run'
  | 'execute_manual'
  | 'reassign_manual'
  | 'manage_environments'
  | 'manage_members'
  | 'manage_settings'

const MATRIX: Record<ProjectAction, ProjectRole[]> = {
  view: ['viewer', 'editor', 'maintainer'],
  edit_tests: ['editor', 'maintainer'],
  run: ['editor', 'maintainer'],
  cancel_own_run: ['editor', 'maintainer'],
  cancel_any_run: ['maintainer'],
  execute_manual: ['editor', 'maintainer'],
  reassign_manual: ['maintainer'],
  manage_environments: ['maintainer'],
  manage_members: ['maintainer'],
  manage_settings: ['maintainer'],
}

export function can(role: ProjectRole | null | undefined, action: ProjectAction, systemRole?: SystemRole): boolean {
  if (systemRole === 'admin') return true
  if (!role) return false
  return MATRIX[action].includes(role)
}

const ROLES: readonly ProjectRole[] = ['maintainer', 'editor', 'viewer']

/** Label & deskripsi role (namespace `common:roles.*`, dibaca lewat i18n → mengikuti bahasa aktif). */
export const ROLE_LABELS: Record<ProjectRole, string> = lazyLabels(ROLES, (r) => `common:roles.${r}.label`)

export const ROLE_DESCRIPTIONS: Record<ProjectRole, string> = lazyLabels(ROLES, (r) => `common:roles.${r}.description`)
