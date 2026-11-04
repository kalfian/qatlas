import { db, persist } from './db'
import { DEMO_PASSWORD } from './constants'

/** Utilitas khusus mode mock (dipakai dev toolbar). Tidak ada padanannya di API asli. */
export const mockDevtools = {
  demoPassword: DEMO_PASSWORD,
  users: () =>
    db()
      .users.filter((u) => u.status === 'active')
      .map((u) => ({ id: u.id, name: u.name, email: u.email, system_role: u.system_role })),
  speed: () => db().sim.speed,
  setSpeed(speed: number) {
    db().sim.speed = speed
    persist()
    window.dispatchEvent(new Event('qatlas:sim-speed'))
  },
}
