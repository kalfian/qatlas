import type en from '../en/tasks'
import type { Translation } from '../../types'

/** Namespace `tasks` (Bahasa Indonesia). Must mirror the English keys. */
export default {
  title: 'Tugas saya',
  description: 'Run manual yang ditugaskan ke kamu di semua project. Yang paling lama menunggu ada di atas.',
  waiting: '{{count}} menunggu',
  emptyTitle: 'Tidak ada tugas manual',
  emptyDescription: 'Run manual yang ditugaskan ke kamu akan muncul di sini.',
  caption: 'Run manual yang menunggu kamu, urut dari yang paling lama',
  col: {
    project: 'Project',
    run: 'Run',
    target: 'Target',
    progress: 'Progres',
    assigned: 'Ditugaskan',
    status: 'Status',
  },
  workOn: 'Kerjakan {{key}}: {{title}}',
  kindFlow: 'Flow',
  kindTestCase: 'Test case',
  assignedAgo: 'Ditugaskan {{time}}',
  step_one: 'step',
  step_other: 'step',
} satisfies Translation<typeof en>
