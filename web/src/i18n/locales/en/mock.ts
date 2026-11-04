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
    reset: 'Reset demo data',
    resetDone: 'Demo data reset',
    switchFailed: "Couldn't switch user",
    switched: 'Signed in as {{name}}',
  },
} as const
