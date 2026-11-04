/**
 * Namespace `common` (English — source of truth for keys). Shared, generic copy any feature may reuse.
 * Keys are STABLE: other features import them, so add keys freely but never rename/remove.
 *
 *   actions.*      save, saveChanges, cancel, delete, remove, edit, create, add, close, back, retry, copy, copied,
 *                  copyCommand, duplicate, rename, confirm, continue, apply, reset, clear, search, open, run, rerun,
 *                  done, undo, discard, refresh, download, upload, view, showMore, showLess, loadMore, select
 *   states.*       loading, saving, saved, deleting, noChanges, noResults, none, never, all, optional, required,
 *                  unknown, empty
 *   errors.*       generic, loadFailed, notFound, forbidden, saveFailed {{message}}, deleteFailed {{message}},
 *                  requestFailed {{status}}, network, technicalDetails, tryAgainLater
 *   validation.*   required, nameRequired, invalidEmail, minChars {{count}}, maxChars {{count}}
 *   fields.*       name, email, description, status, priority, tags, project, projects, role, key, title,
 *                  created, updated, actions, value, type
 *   time.*         justNow, ago {{time}}, in {{time}}, seconds {{value}}, minutesSeconds {{m}} {{s}},
 *                  hoursMinutes {{h}} {{m}}
 *   toast.*        copied, saved, deleted
 *   a11y.*         close, removeTag {{tag}}, openMenu, moreActions
 *   priority.*     critical, high, medium, low            (English in both languages)
 *   testCaseStatus.* draft, ready, deprecated             (English in both languages)
 *   execution.*    automated, manual                      (English in both languages)
 *   roles.*        maintainer|editor|viewer . label|description
 *   languages.*    en, id                                 (endonyms — identical in both languages)
 *
 * Usage in a feature: `const { t } = useTranslation(['tasks', 'common'])` → t('title') for your ns, t('common:actions.save')
 * for shared keys (list 'common' in the array, otherwise the typed `t` rejects the `common:` prefix).
 * Outside React: `import { i18n } from '@/i18n'` → i18n.t('common:actions.save').
 * Interpolation values are typed as strings (`{ message: String(x) }`); `count` takes a number.
 */
export default {
  actions: {
    save: 'Save',
    saveChanges: 'Save changes',
    cancel: 'Cancel',
    delete: 'Delete',
    remove: 'Remove',
    edit: 'Edit',
    create: 'Create',
    add: 'Add',
    close: 'Close',
    back: 'Back',
    retry: 'Retry',
    copy: 'Copy',
    copied: 'Copied',
    copyCommand: 'Copy command',
    duplicate: 'Duplicate',
    rename: 'Rename',
    confirm: 'Confirm',
    continue: 'Continue',
    apply: 'Apply',
    reset: 'Reset',
    clear: 'Clear',
    search: 'Search',
    open: 'Open',
    run: 'Run',
    rerun: 'Rerun',
    done: 'Done',
    undo: 'Undo',
    discard: 'Discard',
    refresh: 'Refresh',
    download: 'Download',
    upload: 'Upload',
    view: 'View',
    showMore: 'Show more',
    showLess: 'Show less',
    loadMore: 'Load more',
    select: 'Select',
  },
  states: {
    loading: 'Loading…',
    saving: 'Saving…',
    saved: 'Saved',
    deleting: 'Deleting…',
    noChanges: 'No changes yet',
    noResults: 'No results',
    none: 'None',
    never: 'Never',
    all: 'All',
    optional: 'Optional',
    required: 'Required',
    unknown: 'Unknown',
    empty: 'Empty',
  },
  errors: {
    generic: 'Something went wrong',
    loadFailed: "Couldn't load data",
    notFound: 'Not found',
    forbidden: "You don't have access to this page",
    saveFailed: "Couldn't save: {{message}}",
    deleteFailed: "Couldn't delete: {{message}}",
    requestFailed: 'Request failed ({{status}})',
    network: "Can't reach the server. Check your connection.",
    technicalDetails: 'Technical details',
    tryAgainLater: 'Try again in a moment.',
  },
  validation: {
    required: 'Required',
    nameRequired: 'Name is required',
    invalidEmail: 'Enter a valid email',
    minChars: 'At least {{count}} characters',
    maxChars: 'At most {{count}} characters',
  },
  fields: {
    name: 'Name',
    email: 'Email',
    description: 'Description',
    status: 'Status',
    priority: 'Priority',
    tags: 'Tags',
    project: 'Project',
    projects: 'Projects',
    role: 'Role',
    key: 'Key',
    title: 'Title',
    created: 'Created',
    updated: 'Updated',
    actions: 'Actions',
    value: 'Value',
    type: 'Type',
  },
  time: {
    justNow: 'just now',
    ago: '{{time}} ago',
    in: 'in {{time}}',
    seconds: '{{value}} s',
    minutesSeconds: '{{m}}m {{s}}s',
    hoursMinutes: '{{h}}h {{m}}m',
  },
  toast: {
    copied: 'Copied to clipboard',
    saved: 'Saved',
    deleted: 'Deleted',
  },
  a11y: {
    close: 'Close',
    removeTag: 'Remove tag {{tag}}',
    openMenu: 'Open menu',
    moreActions: 'More actions',
  },
  priority: {
    critical: 'Critical',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
  },
  testCaseStatus: {
    draft: 'Draft',
    ready: 'Ready',
    deprecated: 'Deprecated',
  },
  execution: {
    automated: 'Automated',
    manual: 'Manual',
  },
  roles: {
    maintainer: {
      label: 'Maintainer',
      description: 'Manages members, environments, and project settings, plus everything an editor can do.',
    },
    editor: {
      label: 'Editor',
      description: 'Creates and edits test cases and flows, starts runs, and executes manual runs.',
    },
    viewer: {
      label: 'Viewer',
      description: 'Can only view test cases, flows, runs, and reports.',
    },
  },
  languages: {
    en: 'English',
    id: 'Bahasa Indonesia',
  },
} as const
