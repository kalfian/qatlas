import type { RunOptions, RunTrigger, Step } from '@/api/types'
import {
  STATE_VERSION,
  type DbEnvironment,
  type DbFlow,
  type DbFolder,
  type DbMember,
  type DbProject,
  type DbTestCase,
  type DbUser,
  type MockState,
} from './db'

import { DEMO_INVITE_TOKEN, DEMO_PASSWORD } from './constants'

export { DEMO_INVITE_TOKEN, DEMO_PASSWORD, GOOGLE_ACCOUNTS } from './constants'

const DAY = 86_400_000

export const DEFAULT_RUN_OPTIONS: RunOptions = {
  browser: 'chromium',
  headless: true,
  viewport: { width: 1280, height: 720 },
  screenshot: 'on_failure',
  video: 'off',
  step_timeout_ms: 10000,
  retries: 0,
}

let stepSeq = 0
const sid = () => `s${(++stepSeq).toString(36)}`
const S = (action: Step['action'], rest: Omit<Step, 'id' | 'action'> = {}): Step => ({ id: sid(), action, ...rest })
const M = (description: string, expected: string): Step => ({ id: sid(), action: 'manual', description, expected })

interface TcSeed {
  folder: string | null
  title: string
  priority: DbTestCase['priority']
  status?: DbTestCase['status']
  execution?: DbTestCase['execution']
  tags: string[]
  description?: string
  preconditions?: string
  variables?: Record<string, string>
  steps: Step[]
}

const loginSteps = (): Step[] => [
  S('goto', { url: '{{env.BASE_URL}}/login', description: 'Open the login page' }),
  S('fill', { selector: 'label=Email', value: '{{vars.email}}' }),
  S('fill', { selector: 'label=Password', value: '{{secret.QA_PASSWORD}}' }),
  S('click', { selector: "role=button[name='Log in']" }),
  S('expect_url', { value: '/account', match: 'contains', description: 'Redirected to the account page', expected: 'URL contains /account' }),
  S('expect_visible', { selector: 'text=Hi, QA Bot' }),
]

const SHOP_CASES: TcSeed[] = [
  { folder: 'Auth', title: 'User can log in with email & password', priority: 'high', tags: ['smoke', 'auth'],
    description: 'Customer login with valid credentials from the environment.', preconditions: 'The QA Bot account is registered and active.',
    variables: { email: 'qa.bot@tokoku.id' }, steps: loginSteps() },
  { folder: 'Auth', title: 'Login fails with a wrong password', priority: 'medium', tags: ['auth', 'negative'],
    variables: { email: 'qa.bot@tokoku.id' },
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/login' }),
      S('fill', { selector: 'label=Email', value: '{{vars.email}}' }),
      S('fill', { selector: 'label=Password', value: 'totally-wrong-123' }),
      S('click', { selector: "role=button[name='Log in']" }),
      S('expect_visible', { selector: 'text=Incorrect email or password', expected: 'An error message is shown' }),
      S('expect_url', { value: '/login', match: 'contains' }),
    ] },
  { folder: 'Auth', title: 'Logout clears the session', priority: 'low', tags: ['auth'],
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/account' }),
      S('click', { selector: "role=button[name='My account']" }),
      S('click', { selector: "role=menuitem[name='Log out']" }),
      S('expect_url', { value: '/login', match: 'contains' }),
    ] },
  { folder: 'Auth', title: 'Log in with SMS OTP', priority: 'high', execution: 'manual', tags: ['auth', 'otp'],
    description: "The OTP is sent to a physical phone, so this can't be automated.", preconditions: "The tester's phone is registered with number 0812-0000-1234.",
    steps: [
      M('Open {{env.BASE_URL}}/login and choose "Log in with phone number"', 'The phone number form is shown'),
      M('Enter 0812-0000-1234 and click "Send OTP"', 'The OTP SMS arrives in under 30 seconds'),
      M('Enter the 6-digit OTP code from the SMS', 'The account page opens and shows the name QA Bot'),
      M('Wait 5 minutes, then try to log in again with the same OTP', 'The message "OTP code expired" is shown'),
    ] },
  { folder: 'Catalog', title: 'Search products by keyword', priority: 'high', tags: ['smoke', 'catalog'],
    steps: [
      S('goto', { url: '{{env.BASE_URL}}' }),
      S('fill', { selector: 'placeholder=Search products', value: 'plain tee' }),
      S('press', { key: 'Enter', selector: 'placeholder=Search products' }),
      S('wait_for', { selector: 'testid=product-card', state: 'visible' }),
      S('expect_count', { selector: 'testid=product-card', op: 'gte', value: 1 }),
      S('expect_url', { value: 'q=plain', match: 'contains' }),
    ] },
  { folder: 'Catalog', title: 'Filter products by category', priority: 'medium', tags: ['catalog'],
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/categories' }),
      S('click', { selector: "role=checkbox[name='Menswear']" }),
      S('expect_url', { value: 'category=menswear', match: 'contains' }),
      S('expect_visible', { selector: "role=heading[name='Menswear']" }),
    ] },
  { folder: 'Catalog', title: 'Product page shows price & stock', priority: 'medium', tags: ['catalog', 'flaky'],
    description: "Sometimes fails because the staging CDN cache hasn't been invalidated yet.",
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/products/plain-black-tee' }),
      S('expect_visible', { selector: 'testid=product-price' }),
      S('expect_text', { selector: 'testid=product-price', value: 'Rp 90.000', match: 'contains' }),
      S('expect_text', { selector: 'testid=stock-label', value: 'Stock', match: 'contains' }),
    ] },
  { folder: 'Cart', title: 'Add a product to the cart', priority: 'high', tags: ['smoke', 'cart'],
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/products/plain-black-tee' }),
      S('select_option', { selector: 'label=Size', label: 'L' }),
      S('click', { selector: "role=button[name='Add to cart']" }),
      S('expect_visible', { selector: 'text=Added to cart' }),
      S('expect_text', { selector: 'testid=cart-count', value: '1', match: 'equals' }),
    ] },
  { folder: 'Cart', title: 'Change item quantity in the cart', priority: 'medium', tags: ['cart'],
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/cart' }),
      S('fill', { selector: 'label=Quantity', value: '3' }),
      S('press', { key: 'Tab' }),
      S('expect_value', { selector: 'label=Quantity', value: '3', match: 'equals' }),
    ] },
  { folder: 'Cart', title: 'Remove an item from the cart', priority: 'low', status: 'draft', tags: ['cart'],
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/cart' }),
      S('click', { selector: "role=button[name='Remove item']" }),
      S('expect_visible', { selector: 'text=Your cart is empty' }),
    ] },
  { folder: 'Checkout', title: 'Checkout with bank transfer', priority: 'critical', tags: ['checkout', 'smoke'],
    preconditions: 'The cart has at least 1 item.',
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/checkout' }),
      S('fill', { selector: 'label=Address', value: 'Jl. Merdeka No. 10, Bandung' }),
      S('click', { selector: "role=radio[name='Bank transfer']" }),
      S('click', { selector: "role=button[name='Pay now']" }),
      S('expect_visible', { selector: "role=heading[name='Order placed']" }),
      S('extract_text', { selector: 'testid=order-id', save_as: 'order_id' }),
    ] },
  { folder: 'Checkout', title: 'Checkout with 10% voucher', priority: 'high', tags: ['checkout', 'voucher'],
    description: 'Voucher HEMAT10 should take 10% off the Rp 90.000 subtotal.',
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/checkout' }),
      S('fill', { selector: 'label=Voucher code', value: 'HEMAT10' }),
      S('click', { selector: "role=button[name='Apply']" }),
      S('expect_visible', { selector: 'text=Voucher HEMAT10 applied' }),
      S('expect_text', { selector: 'testid=grand-total', value: 'Rp 81.000', match: 'equals', description: 'Total after discount', expected: 'Rp 81.000' }),
      S('click', { selector: "role=button[name='Pay now']" }),
    ] },
  { folder: 'Payment', title: 'E-wallet payment (redirect)', priority: 'high', tags: ['checkout', 'payment'],
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/checkout' }),
      S('click', { selector: "role=radio[name='E-wallet']" }),
      S('click', { selector: "role=button[name='Pay now']" }),
      S('expect_url', { value: 'sandbox.pay.tokoku.id', match: 'contains' }),
      S('click', { selector: "role=button[name='Simulate success']" }),
      S('expect_visible', { selector: "role=heading[name='Order placed']" }),
    ] },
  { folder: 'Checkout', title: 'Check the invoice PDF', priority: 'medium', execution: 'manual', tags: ['checkout', 'visual'],
    steps: [
      M('Open the latest order and click "Download invoice"', 'A PDF downloads and its file name contains the order number'),
      M('Check the logo, store address, and tax ID (NPWP) in the invoice header', 'Everything is sharp and matches the brand guideline'),
      M('Compare subtotal, discount, shipping, and total with the order page', 'All amounts match exactly'),
    ] },
  { folder: 'API', title: 'GET /products returns a product list', priority: 'high', tags: ['api', 'smoke'],
    steps: [
      S('http_request', { method: 'GET', url: '{{env.API_URL}}/v1/products', query: { limit: '10' } }),
      S('expect_status', { value: 200 }),
      S('expect_json', { path: '$.data[0].id', op: 'exists' }),
      S('expect_response_time', { max_ms: 800 }),
    ] },
  { folder: 'API', title: 'Login API returns a token', priority: 'high', tags: ['api', 'auth'],
    steps: [
      S('http_request', { method: 'POST', url: '{{env.API_URL}}/v1/auth/login', body_type: 'json',
        body: '{"email":"qa.bot@tokoku.id","password":"{{secret.QA_PASSWORD}}"}', save: { token: '$.data.token' } }),
      S('expect_status', { value: 201 }),
      S('expect_json', { path: '$.data.token', op: 'exists' }),
    ] },
  { folder: 'API', title: 'Create an order via API, then verify it in the UI', priority: 'medium', tags: ['api', 'checkout'],
    description: 'Mixed test example: data is created through the API and verified in the browser.',
    steps: [
      S('http_request', { method: 'POST', url: '{{env.API_URL}}/v1/orders', body_type: 'json',
        headers: { Authorization: 'Bearer {{secret.ADMIN_TOKEN}}' }, body: '{"sku":"PBT-L","qty":1}', save: { order_id: '$.data.id' } }),
      S('expect_status', { value: 201 }),
      S('goto', { url: '{{env.BASE_URL}}/account/orders/{{vars.order_id}}' }),
      S('expect_visible', { selector: 'text=Awaiting payment' }),
    ] },
  { folder: null, title: 'Home page loads without errors', priority: 'medium', tags: ['smoke'],
    steps: [
      S('goto', { url: '{{env.BASE_URL}}' }),
      S('expect_title', { value: 'Tokoku', match: 'contains' }),
      S('expect_visible', { selector: "role=navigation[name='Main']" }),
      S('screenshot', { name: 'home', full_page: true }),
    ] },
  { folder: 'Auth', title: 'Reset password via email', priority: 'low', status: 'draft', execution: 'manual', tags: ['auth'],
    steps: [
      M('On the login page click "Forgot password" and enter qa.bot@tokoku.id', 'The message "Check your email" is shown'),
      M('Open the reset email in the QA inbox and click the link', 'The set-new-password page opens'),
    ] },
]

const PAY_CASES: TcSeed[] = [
  { folder: 'Payment intent', title: 'Create a payment intent', priority: 'critical', tags: ['api', 'smoke'],
    steps: [
      S('http_request', { method: 'POST', url: '{{env.API_URL}}/v2/payment-intents', body_type: 'json',
        headers: { 'X-Api-Key': '{{secret.API_KEY}}' }, body: '{"amount":90000,"currency":"IDR"}', save: { intent_id: '$.data.id' } }),
      S('expect_status', { value: 201 }),
      S('expect_json', { path: '$.data.status', op: 'eq', value: 'requires_payment' }),
    ] },
  { folder: 'Webhook', title: 'Payment succeeded webhook', priority: 'high', tags: ['api', 'webhook'],
    steps: [
      S('http_request', { method: 'POST', url: '{{env.API_URL}}/v2/test/webhooks', body_type: 'json', body: '{"event":"payment.succeeded"}' }),
      S('expect_status', { value: 200 }),
      S('expect_json', { path: '$.delivered', op: 'eq', value: 'true' }),
    ] },
  { folder: 'Refund', title: 'Partial refund', priority: 'medium', tags: ['api', 'refund', 'flaky'],
    steps: [
      S('http_request', { method: 'POST', url: '{{env.API_URL}}/v2/refunds', body_type: 'json', body: '{"payment_id":"pay_123","amount":10000}' }),
      S('expect_status', { value: 201 }),
      S('expect_json', { path: '$.data.amount', op: 'eq', value: '10000' }),
    ] },
  { folder: 'Webhook', title: 'Validate the bank callback signature', priority: 'medium', execution: 'manual', tags: ['security'],
    steps: [
      M('Send a callback with a valid signature from the bank sandbox dashboard', 'The callback is accepted with status 200 in the logs'),
      M('Change 1 character of the signature and send it again', 'The callback is rejected with status 401'),
    ] },
]

/**
 * SHOP cases added later (2FA, email verification). Appended after SHOP_CASES (keys SHOP-T20…T22)
 * and declared after PAY_CASES, so the existing keys and step ids stay unchanged.
 */
const SHOP_AUTH_EMAIL_CASES: TcSeed[] = [
  { folder: 'Auth', title: 'Log in with TOTP 2FA', priority: 'high', tags: ['auth', '2fa'],
    description: 'Password login followed by a time-based one-time code (RFC 6238) generated from the QA_TOTP_SEED secret.',
    preconditions: 'qa.2fa@tokoku.id has two-factor authentication enabled with the seed stored in QA_TOTP_SEED.',
    variables: { email: 'qa.2fa@tokoku.id' },
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/login', description: 'Open the login page' }),
      S('fill', { selector: 'label=Email', value: '{{vars.email}}' }),
      S('fill', { selector: 'label=Password', value: '{{secret.QA_PASSWORD}}' }),
      S('click', { selector: "role=button[name='Log in']" }),
      S('expect_url', { value: '/login/2fa', match: 'contains', description: 'The second factor is requested' }),
      S('fill', { selector: 'label=Authentication code', value: '{{fn.totp secret.QA_TOTP_SEED}}', description: 'Current 6-digit TOTP code' }),
      S('click', { selector: "role=button[name='Verify']" }),
      S('expect_url', { value: '/account', match: 'contains', description: 'Redirected to the account page', expected: 'URL contains /account' }),
      S('expect_visible', { selector: 'text=Hi, QA 2FA' }),
    ] },
  { folder: 'Email', title: 'Sign up and verify email (Mailpit)', priority: 'high', tags: ['auth', 'email', 'signup'],
    description: 'Signs up with a fresh address, waits for the verification email in Mailpit, and opens the link from it.',
    preconditions: 'The shop sends its email to the Mailpit instance at MAILPIT_URL.',
    steps: [
      S('set_variable', { name: 'email', value: '{{fn.random_email}}', description: 'A fresh address for every run' }),
      S('goto', { url: '{{env.BASE_URL}}/signup' }),
      S('fill', { selector: 'label=Name', value: 'QA Signup' }),
      S('fill', { selector: 'label=Email', value: '{{vars.email}}' }),
      S('fill', { selector: 'label=Password', value: 'Signup-Demo-2026!' }),
      S('click', { selector: "role=button[name='Create account']" }),
      S('expect_visible', { selector: "role=heading[name='Check your email']" }),
      S('http_request', { method: 'GET', url: '{{env.MAILPIT_URL}}/api/v1/search', query: { query: 'to:{{vars.email}}' },
        poll_timeout_ms: 15000, poll_interval_ms: 500, poll_until: '$.messages[0].ID', save: { mail_id: '$.messages[0].ID' },
        description: 'Wait for the verification email', expected: 'One message to the new address' }),
      S('expect_json', { path: '$.messages[0].Subject', op: 'eq', value: 'Verify your Tokoku account' }),
      S('http_request', { method: 'GET', url: '{{env.MAILPIT_URL}}/api/v1/message/{{vars.mail_id}}/raw',
        save_regex: { verify_url: 'href="([^"]+/verify\\?token=[^"]+)"' }, regex_decode: 'auto',
        description: 'Read the raw email (quoted-printable HTML) and take the link' }),
      S('goto', { url: '{{vars.verify_url}}', description: 'Open the verification link' }),
      S('expect_visible', { selector: "role=heading[name='Email verified']" }),
    ] },
  { folder: 'Email', title: 'Verify email with the 6-digit code', priority: 'medium', tags: ['auth', 'email', 'signup'],
    description: 'Same sign-up, but confirms the address with the code from the email instead of the link.',
    preconditions: 'The shop sends its email to the Mailpit instance at MAILPIT_URL.',
    steps: [
      S('set_variable', { name: 'email', value: '{{fn.random_email}}' }),
      S('goto', { url: '{{env.BASE_URL}}/signup' }),
      S('fill', { selector: 'label=Name', value: 'QA Code' }),
      S('fill', { selector: 'label=Email', value: '{{vars.email}}' }),
      S('fill', { selector: 'label=Password', value: 'Signup-Demo-2026!' }),
      S('click', { selector: "role=button[name='Create account']" }),
      S('expect_visible', { selector: "role=heading[name='Check your email']" }),
      S('http_request', { method: 'GET', url: '{{env.MAILPIT_URL}}/api/v1/search', query: { query: 'to:{{vars.email}}' },
        poll_timeout_ms: 15000, poll_interval_ms: 500, poll_until: '$.messages[0].ID', save: { mail_id: '$.messages[0].ID' },
        description: 'Wait for the verification email' }),
      S('http_request', { method: 'GET', url: '{{env.MAILPIT_URL}}/api/v1/message/{{vars.mail_id}}',
        save_regex: { code: 'code is (\\d{6})' }, regex_decode: 'auto', description: 'Take the 6-digit code from the email' }),
      S('fill', { selector: 'label=Verification code', value: '{{vars.code}}' }),
      S('click', { selector: "role=button[name='Verify']" }),
      S('expect_visible', { selector: "role=heading[name='Email verified']" }),
    ] },
]

/* ------------------------------------------------------------------ builder */

export function buildSeed(): MockState {
  stepSeq = 0
  const now = Date.now()
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString()

  const users: DbUser[] = [
    { id: 'u_rina', email: 'rina@tokoku.id', name: 'Rina Kusuma', system_role: 'admin', status: 'active', password: DEMO_PASSWORD, google_linked: true, last_login_at: iso(DAY / 4), created_at: iso(60 * DAY) },
    { id: 'u_dimas', email: 'dimas@tokoku.id', name: 'Dimas Pratama', system_role: 'member', status: 'active', password: DEMO_PASSWORD, google_linked: true, last_login_at: iso(DAY / 2), created_at: iso(55 * DAY) },
    { id: 'u_sari', email: 'sari@tokoku.id', name: 'Sari Wulandari', system_role: 'member', status: 'active', password: DEMO_PASSWORD, google_linked: false, last_login_at: iso(3 * DAY), created_at: iso(40 * DAY) },
    { id: 'u_budi', email: 'budi@tokoku.id', name: 'Budi Santoso', system_role: 'member', status: 'invited', password: null, google_linked: false, last_login_at: null, created_at: iso(DAY) },
    { id: 'u_yoga', email: 'yoga@tokoku.id', name: 'Yoga Firmansyah', system_role: 'member', status: 'disabled', password: DEMO_PASSWORD, google_linked: false, last_login_at: iso(20 * DAY), created_at: iso(50 * DAY) },
  ]

  const projects: DbProject[] = [
    { id: 'p_shop', key: 'SHOP', name: 'Tokoku Web Store', description: 'Storefront smoke & regression for tokoku.id', archived_at: null,
      default_run_options: { ...DEFAULT_RUN_OPTIONS }, artifact_retention_days: 30, created_at: iso(58 * DAY), seq: { case: 0, flow: 0, run: 100 } },
    { id: 'p_pay', key: 'PAY', name: 'Payment API', description: 'Payment API contracts & integrations', archived_at: null,
      default_run_options: { ...DEFAULT_RUN_OPTIONS }, artifact_retention_days: 14, created_at: iso(45 * DAY), seq: { case: 0, flow: 0, run: 20 } },
  ]

  const members: DbMember[] = [
    { project_id: 'p_shop', user_id: 'u_rina', role: 'maintainer', added_at: iso(58 * DAY) },
    { project_id: 'p_shop', user_id: 'u_dimas', role: 'editor', added_at: iso(55 * DAY) },
    { project_id: 'p_shop', user_id: 'u_sari', role: 'viewer', added_at: iso(40 * DAY) },
    { project_id: 'p_pay', user_id: 'u_dimas', role: 'maintainer', added_at: iso(45 * DAY) },
    { project_id: 'p_pay', user_id: 'u_sari', role: 'editor', added_at: iso(40 * DAY) },
  ]

  const environments: DbEnvironment[] = [
    { id: 'env_shop_stg', project_id: 'p_shop', name: 'staging', is_default: true,
      variables: { BASE_URL: 'https://staging.tokoku.id', API_URL: 'https://api.staging.tokoku.id', MAILPIT_URL: 'https://mailpit.staging.tokoku.id' },
      secrets: [
        { name: 'QA_PASSWORD', value: 'Qa-Staging-2026!', updated_at: iso(12 * DAY) },
        { name: 'ADMIN_TOKEN', value: 'adm_stg_8f3a', updated_at: iso(30 * DAY) },
        // demo-target's public demo-only TOTP seed (DEMO_TOTP_SEED default) of qa.2fa@tokoku.id
        { name: 'QA_TOTP_SEED', value: 'TOKOKU2FADEMOSEEDQATLASTOTPDEMOA', updated_at: iso(2 * DAY) },
      ], updated_at: iso(2 * DAY) },
    { id: 'env_shop_prod', project_id: 'p_shop', name: 'production', is_default: false,
      variables: { BASE_URL: 'https://tokoku.id', API_URL: 'https://api.tokoku.id' },
      secrets: [{ name: 'QA_PASSWORD', value: 'Qa-Prod-2026!', updated_at: iso(20 * DAY) }], updated_at: iso(20 * DAY) },
    { id: 'env_pay_sbx', project_id: 'p_pay', name: 'sandbox', is_default: true,
      variables: { API_URL: 'https://sandbox.pay.tokoku.id' },
      secrets: [{ name: 'API_KEY', value: 'sk_sbx_123', updated_at: iso(10 * DAY) }], updated_at: iso(10 * DAY) },
  ]

  const folders: DbFolder[] = []
  const folderId = (projectId: string, name: string, parent: string | null = null) => {
    let f = folders.find((x) => x.project_id === projectId && x.name === name)
    if (!f) {
      f = { id: `f_${projectId}_${name.toLowerCase().replace(/\W+/g, '_')}`, project_id: projectId, parent_id: parent, name,
        position: folders.filter((x) => x.project_id === projectId && x.parent_id === parent).length }
      folders.push(f)
    }
    return f.id
  }
  for (const n of ['Auth', 'Catalog', 'Cart', 'Checkout', 'API']) folderId('p_shop', n)
  folderId('p_shop', 'Payment', folderId('p_shop', 'Checkout'))
  for (const n of ['Payment intent', 'Webhook', 'Refund']) folderId('p_pay', n)

  const testCases: DbTestCase[] = []
  const makeCases = (project: DbProject, seeds: TcSeed[], authorIds: string[]) => {
    seeds.forEach((c, i) => {
      project.seq.case += 1
      const created = now - (50 - i) * DAY
      testCases.push({
        id: `tc_${project.key.toLowerCase()}_${project.seq.case}`,
        project_id: project.id,
        key: `${project.key}-T${project.seq.case}`,
        folder_id: c.folder ? folderId(project.id, c.folder) : null,
        title: c.title,
        description: c.description ?? '',
        preconditions: c.preconditions ?? '',
        priority: c.priority,
        status: c.status ?? 'ready',
        execution: c.execution ?? 'automated',
        tags: c.tags,
        variables: c.variables ?? {},
        steps: structuredClone(c.steps),
        revision: 1 + (i % 3),
        created_at: new Date(created).toISOString(),
        created_by: authorIds[i % authorIds.length],
        updated_at: new Date(created + (i % 5) * DAY).toISOString(),
        updated_by: authorIds[(i + 1) % authorIds.length],
        deleted_at: null,
      })
    })
  }
  makeCases(projects[0], [...SHOP_CASES, ...SHOP_AUTH_EMAIL_CASES], ['u_rina', 'u_dimas'])
  makeCases(projects[1], PAY_CASES, ['u_dimas', 'u_sari'])

  const revisions = testCases.flatMap((t) =>
    Array.from({ length: t.revision }, (_, r) => ({
      test_case_id: t.id,
      revision: r + 1,
      author_id: r === 0 ? t.created_by : t.updated_by,
      change_note: r === 0 ? 'Created' : r === 1 ? 'Fix button selector' : 'Add assertion',
      created_at: new Date(Date.parse(t.created_at) + r * DAY).toISOString(),
      snapshot: {
        folder_id: t.folder_id, title: t.title, description: t.description, preconditions: t.preconditions, priority: t.priority,
        status: t.status, execution: t.execution, tags: t.tags, variables: t.variables,
        steps: structuredClone(r + 1 === t.revision ? t.steps : t.steps.slice(0, Math.max(1, t.steps.length - (t.revision - r - 1)))),
      },
    })),
  )

  const tcId = (key: string) => testCases.find((t) => t.key === key)!.id
  const flowItem = (key: string, cof = false) => ({ id: `fi_${key}_${Math.random().toString(36).slice(2, 7)}`, test_case_id: tcId(key), continue_on_failure: cof, enabled: true })
  const flows: DbFlow[] = [
    { id: 'fl_shop_1', project_id: 'p_shop', key: 'SHOP-F1', name: 'Checkout happy path', description: 'Login → cart → bank transfer checkout in one browser session.',
      tags: ['checkout', 'smoke'], shared_session: true, stop_on_failure: true, variables: { email: 'qa.bot@tokoku.id' },
      items: [flowItem('SHOP-T1'), flowItem('SHOP-T8'), flowItem('SHOP-T11')], revision: 3, created_at: iso(30 * DAY), updated_at: iso(6 * DAY), deleted_at: null },
    { id: 'fl_shop_2', project_id: 'p_shop', key: 'SHOP-F2', name: 'Daily smoke test', description: 'A quick check of the main features every morning.',
      tags: ['smoke'], shared_session: false, stop_on_failure: false, variables: { email: 'qa.bot@tokoku.id' },
      items: ['SHOP-T18', 'SHOP-T1', 'SHOP-T5', 'SHOP-T8', 'SHOP-T15'].map((k) => flowItem(k)), revision: 5, created_at: iso(28 * DAY), updated_at: iso(3 * DAY), deleted_at: null },
    { id: 'fl_shop_3', project_id: 'p_shop', key: 'SHOP-F3', name: 'Checkout regression + manual invoice check', description: 'Automated checkout steps plus a manual invoice check.',
      tags: ['checkout', 'regression'], shared_session: false, stop_on_failure: true, variables: { email: 'qa.bot@tokoku.id' },
      items: [flowItem('SHOP-T1'), flowItem('SHOP-T8'), flowItem('SHOP-T11'), flowItem('SHOP-T14'), flowItem('SHOP-T3')], revision: 2, created_at: iso(14 * DAY), updated_at: iso(2 * DAY), deleted_at: null },
    { id: 'fl_pay_1', project_id: 'p_pay', key: 'PAY-F1', name: 'Full payment flow', description: 'Intent → webhook → refund.',
      tags: ['api'], shared_session: false, stop_on_failure: true, variables: {},
      items: [flowItem('PAY-T1'), flowItem('PAY-T2'), flowItem('PAY-T3', true)], revision: 1, created_at: iso(20 * DAY), updated_at: iso(20 * DAY), deleted_at: null },
  ]
  projects[0].seq.flow = 3
  projects[1].seq.flow = 1

  return {
    version: STATE_VERSION,
    session: null,
    users,
    invites: [{ token: DEMO_INVITE_TOKEN, user_id: 'u_budi', kind: 'invite', expires_at: iso(-2 * DAY), used_at: null }],
    tokens: [
      { id: 'tok_1', user_id: 'u_rina', name: 'Claude Code laptop', prefix: 'qat_7f2c91ab', scopes: ['read', 'write', 'run'], project_keys: null,
        expires_at: iso(-80 * DAY), last_used_at: iso(DAY / 3), created_at: iso(10 * DAY), revoked_at: null },
      { id: 'tok_2', user_id: 'u_rina', name: 'CI GitHub Actions', prefix: 'qat_b03de4c1', scopes: ['read', 'run'], project_keys: ['SHOP'],
        expires_at: null, last_used_at: iso(DAY), created_at: iso(25 * DAY), revoked_at: null },
    ],
    projects,
    members,
    environments,
    folders,
    testCases,
    revisions,
    flows,
    runs: [],
    artifacts: [],
    sim: { speed: 1 },
  }
}

export interface HistorySpec {
  projectKey: string
  kind: 'test_case' | 'flow'
  target: string
  daysAgo: number
  user: string
  trigger?: RunTrigger
  options?: Partial<RunOptions>
  env?: string
  cancel?: boolean
  infraError?: string
  manual?: { by: string; results: ('passed' | 'failed' | 'blocked' | 'skipped')[]; notes?: string[] } | 'leave-open'
  assignee?: string
}

/** Spesifikasi riwayat run (dieksekusi oleh history.ts memakai simulator). */
export function historySpecs(): HistorySpec[] {
  const specs: HistorySpec[] = []
  const shopCaseTargets = ['SHOP-T1', 'SHOP-T5', 'SHOP-T7', 'SHOP-T8', 'SHOP-T12', 'SHOP-T15', 'SHOP-T16', 'SHOP-T11', 'SHOP-T17', 'SHOP-T2']
  const users = ['u_rina', 'u_dimas']
  const triggers: RunTrigger[] = ['manual', 'manual', 'mcp', 'api', 'manual', 'schedule']
  for (let d = 13; d >= 0; d--) {
    specs.push({ projectKey: 'SHOP', kind: 'flow', target: 'SHOP-F2', daysAgo: d + 0.62, user: 'u_rina', trigger: 'schedule' })
    const n = d % 3 === 0 ? 3 : 2
    for (let k = 0; k < n; k++) {
      const target = shopCaseTargets[(d * 3 + k) % shopCaseTargets.length]
      specs.push({
        projectKey: 'SHOP', kind: 'test_case', target, daysAgo: d + 0.3 - k * 0.07, user: users[(d + k) % 2], trigger: triggers[(d + k) % triggers.length],
        options: (d + k) % 4 === 0 ? { screenshot: 'every_step', video: 'always' } : { screenshot: 'on_failure', video: 'on_failure' },
      })
    }
    if (d % 4 === 1) specs.push({ projectKey: 'SHOP', kind: 'flow', target: 'SHOP-F1', daysAgo: d + 0.2, user: 'u_dimas', options: { video: 'always', screenshot: 'every_step' } })
    if (d % 5 === 2) specs.push({ projectKey: 'PAY', kind: 'flow', target: 'PAY-F1', daysAgo: d + 0.4, user: 'u_dimas', trigger: 'api' })
    if (d % 3 === 1) specs.push({ projectKey: 'PAY', kind: 'test_case', target: 'PAY-T1', daysAgo: d + 0.5, user: 'u_sari', trigger: 'mcp' })
  }
  specs.push({ projectKey: 'SHOP', kind: 'test_case', target: 'SHOP-T5', daysAgo: 5.1, user: 'u_dimas', cancel: true })
  specs.push({ projectKey: 'SHOP', kind: 'test_case', target: 'SHOP-T13', daysAgo: 4.2, user: 'u_dimas', infraError: 'Failed to launch webkit browser: missing dependency libgstcodecparsers-1.0.so.0', options: { browser: 'webkit' } })
  specs.push({ projectKey: 'SHOP', kind: 'test_case', target: 'SHOP-T4', daysAgo: 6.3, user: 'u_dimas',
    manual: { by: 'u_dimas', results: ['passed', 'passed', 'passed', 'failed'], notes: ['', '', '', 'The old OTP still works after 5 minutes — security bug, reported to the auth team.'] } })
  specs.push({ projectKey: 'SHOP', kind: 'flow', target: 'SHOP-F3', daysAgo: 2.4, user: 'u_rina',
    manual: { by: 'u_rina', results: ['passed', 'passed', 'passed'] } })
  // masih terbuka → muncul di "My tasks"
  specs.push({ projectKey: 'SHOP', kind: 'flow', target: 'SHOP-F3', daysAgo: 0.08, user: 'u_rina', manual: 'leave-open', assignee: 'u_rina' })
  specs.push({ projectKey: 'SHOP', kind: 'test_case', target: 'SHOP-T4', daysAgo: 0.2, user: 'u_rina', manual: 'leave-open', assignee: 'u_dimas' })
  specs.push({ projectKey: 'PAY', kind: 'test_case', target: 'PAY-T4', daysAgo: 1.1, user: 'u_dimas', manual: 'leave-open', assignee: 'u_rina' })
  return specs.sort((a, b) => b.daysAgo - a.daysAgo)
}
