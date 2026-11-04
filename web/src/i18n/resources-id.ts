// Indonesian bundles — loaded on demand by setLanguage('id') (see index.ts); keep in sync with resources.ts.
import id_common from './locales/id/common'
import id_nav from './locales/id/nav'
import id_status from './locales/id/status'
import id_steps from './locales/id/steps'
import id_auth from './locales/id/auth'
import id_account from './locales/id/account'
import id_admin from './locales/id/admin'
import id_tasks from './locales/id/tasks'
import id_projects from './locales/id/projects'
import id_dashboard from './locales/id/dashboard'
import id_environments from './locales/id/environments'
import id_settings from './locales/id/settings'
import id_testcases from './locales/id/testcases'
import id_flows from './locales/id/flows'
import id_runs from './locales/id/runs'
import id_mock from './locales/id/mock'
import id_storage from './locales/id/storage'
import type { Translation } from './types'
import type { resources } from './resources'

type EnBundles = (typeof resources)['en']

/** Same namespaces as English; each file already `satisfies Translation<typeof en>` for key parity. */
const id = { common: id_common, nav: id_nav, status: id_status, steps: id_steps, auth: id_auth, account: id_account, admin: id_admin, tasks: id_tasks, projects: id_projects, dashboard: id_dashboard, environments: id_environments, settings: id_settings, testcases: id_testcases, flows: id_flows, runs: id_runs, mock: id_mock, storage: id_storage, } satisfies { [NS in keyof EnBundles]: Translation<EnBundles[NS]> }

export default id
