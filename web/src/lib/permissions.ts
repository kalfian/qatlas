import type { ProjectRole, SystemRole } from '@/api/types'

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

export const ROLE_LABELS: Record<ProjectRole, string> = {
  maintainer: 'Maintainer',
  editor: 'Editor',
  viewer: 'Viewer',
}

export const ROLE_DESCRIPTIONS: Record<ProjectRole, string> = {
  maintainer: 'Kelola member, environment, dan setting project; plus semua hak editor.',
  editor: 'Buat & ubah test case/flow, jalankan run, kerjakan run manual.',
  viewer: 'Hanya melihat test case, flow, run, dan report.',
}
