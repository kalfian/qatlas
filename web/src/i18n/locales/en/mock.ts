/** Namespace `mock` (English — source of truth for keys). Mock-mode dev toolbar (Phase 1 only). */
export default {
  toolbar: {
    trigger: 'Mock mode dev toolbar',
    button: 'Mock',
    title: 'Mock mode (Phase 1)',
    intro: 'All data is simulated in the browser (MSW + localStorage). Password for every demo user:',
    signInAs: 'Sign in as',
    speed: 'Run simulation speed',
    speedLabel: 'Simulation speed',
    rulesTitle: 'Simulation rules',
    ruleFail: 'A step parameter containing the word <code>fail</code> → the step fails.',
    ruleVoucher: '<code>testid=grand-total</code> reads <code>Rp 90.000</code> in the fake app (the voucher test fails on purpose).',
    ruleFlaky: 'Tests tagged <code>flaky</code> fail randomly ~40% of the time.',
    ruleStorage:
      'Storage: an endpoint containing <code>fail</code> or the secret <code>wrong</code> fails the connection check; a bucket containing <code>quota</code> stops an artifact move at 60%.',
    googleEnv: 'Google sign-in set by environment variables',
    googleEnvHint: 'Simulates GOOGLE_CLIENT_ID on the server: Google sign-in is on and Admin → Google sign-in turns read-only.',
    ruleGoogle:
      'Google sign-in: Admin → Google sign-in accepts any Web application client JSON; a Desktop client or a <code>client_id</code> outside <code>apps.googleusercontent.com</code> is rejected.',
    storageEnv: 'Storage set by environment variables',
    storageEnvHint: 'Simulates QATLAS_STORAGE on the server: Admin → Storage turns read-only.',
    reset: 'Reset demo data',
    resetDone: 'Demo data reset',
    switchFailed: "Couldn't switch user",
    switched: 'Signed in as {{name}}',
  },
} as const
