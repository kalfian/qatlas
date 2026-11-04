import { useParams } from '@tanstack/react-router'
import { useMe } from '@/api/queries'
import type { Me, ProjectRole } from '@/api/types'
import { can, type ProjectAction } from '@/lib/permissions'

/** Data user yang login. Hanya dipakai di bawah route terproteksi (AppShell menjamin sudah ada). */
export function useAuth(): Me {
  const { data } = useMe()
  if (!data) throw new Error('useAuth dipakai di luar route terproteksi')
  return data
}

export function useProjectRole(projectKey: string | undefined): ProjectRole | null {
  const me = useAuth()
  if (!projectKey) return null
  const p = me.projects.find((x) => x.key === projectKey)
  if (p) return p.role
  return me.user.system_role === 'admin' ? 'maintainer' : null
}

/** Cek izin pada project aktif (diambil dari param $key) atau project tertentu. */
export function useCan(action: ProjectAction, projectKey?: string): boolean {
  const params = useParams({ strict: false }) as { key?: string }
  const key = projectKey ?? params.key
  const me = useAuth()
  const role = useProjectRole(key)
  return can(role, action, me.user.system_role)
}

export function useIsAdmin(): boolean {
  return useAuth().user.system_role === 'admin'
}
