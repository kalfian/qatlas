/** Namespace `tasks` (English — source of truth for keys). */
export default {
  title: 'My tasks',
  description: 'Manual runs assigned to you across all projects. The longest-waiting ones are on top.',
  waiting: '{{count}} waiting',
  emptyTitle: 'No manual tasks',
  emptyDescription: 'Manual runs assigned to you will show up here.',
  caption: 'Manual runs waiting for you, oldest first',
  col: {
    project: 'Project',
    run: 'Run',
    target: 'Target',
    progress: 'Progress',
    assigned: 'Assigned',
    status: 'Status',
  },
  workOn: 'Work on {{key}}: {{title}}',
  kindFlow: 'Flow',
  kindTestCase: 'Test case',
  assignedAgo: 'Assigned {{time}}',
  step_one: 'step',
  step_other: 'steps',
} as const
