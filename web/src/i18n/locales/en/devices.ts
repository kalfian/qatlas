/**
 * Namespace `devices` (English — source of truth for keys). Device picker, device chips/summaries,
 * category names and device validation messages (docs/14-responsive-testing.md).
 * Device labels from the catalog (iPhone 15, iPad Mini, …) are product names and are not translated.
 */
export default {
  category: {
    desktop: 'Desktop',
    tablet: 'Tablet',
    mobile: 'Mobile',
  },
  /** Lower-case category word used inside sentences ("2 mobile", "Not run on tablet"). */
  categoryWord: {
    desktop: 'desktop',
    tablet: 'tablet',
    mobile: 'mobile',
  },
  summary: {
    count_one: '{{count}} device',
    count_other: '{{count}} devices',
    ofCategory: '{{count}} {{category}}',
  },
  picker: {
    label: 'Devices',
    trigger: 'Choose devices: {{summary}}',
    hint: 'Every case runs once per device. Up to {{max}}.',
    selected: 'Selected devices',
    remove: 'Remove {{label}}',
    lastOne: 'At least one device is required',
    limitReached: 'Limit of {{max}} devices reached. Remove one to add another.',
    custom: 'Custom size',
    width: 'Width',
    height: 'Height',
    widthAria: 'Custom width in pixels',
    heightAria: 'Custom height in pixels',
    add: 'Add',
    addAria: 'Add custom size',
    countsAs: 'Counts as {{category}} · DPR 1 · no touch',
    added: '{{label}} added',
    firefoxNote: "Firefox can't emulate isMobile; size, touch and user agent still apply.",
    done: 'Done',
  },
  chip: {
    customTitle: 'Custom size (DPR 1, no touch)',
    presetTitle: '{{label}} · DPR {{dpr}}{{touch}}',
    touch: ' · touch',
  },
  onlyOn: {
    label: 'Only on',
    help: 'Run this step only on these device types; elsewhere it is skipped. None selected = every device.',
    all: 'All devices',
    badgeOne: '{{category}} only',
    badgeMany: '{{list}}',
    join: ' + ',
    a11y: 'only on {{list}}',
  },
  validation: {
    notList: 'Must be a list of devices',
    empty: 'Choose at least one device',
    tooMany: 'Choose at most {{max}} devices',
    idRequired: 'Device id is required',
    unknownId: 'Unknown device "{{id}}". Use one of: {{ids}}, or custom',
    widthRequired: 'Width is required for a custom device',
    heightRequired: 'Height is required for a custom device',
    range: 'Must be between {{min}} and {{max}}',
    category: 'Use mobile, tablet or desktop',
    label: 'Must be at most {{max}} characters',
    duplicate: 'Device {{label}} is already selected (devices[{{index}}])',
    /** Picker (custom size typed by the user). */
    width: 'Width must be a whole number between {{min}} and {{max}}',
    height: 'Height must be a whole number between {{min}} and {{max}}',
    alreadyAdded: '{{label}} is already in the list',
  },
} as const
