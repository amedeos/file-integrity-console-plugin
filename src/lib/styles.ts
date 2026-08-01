/**
 * PatternFly class names and design tokens, in one place.
 *
 * Both are versioned with PatternFly, which in turn is versioned with the
 * console: utility classes are prefixed `pf-v6-` from OpenShift 4.19 and
 * `pf-v5-` before it, and PatternFly 6 replaced the `--pf-v5-global--*`
 * variables with `--pf-t--global--*` tokens.
 *
 * Neither is type-checked — they are strings that either match the stylesheet
 * the console loaded or silently do nothing. Keeping them here means a release
 * branch changes one file rather than fourteen call sites, and that a mismatch
 * is visible in one diff instead of hiding in JSX.
 *
 * Silently doing nothing is not hypothetical: `pf-v6-u-color-200` sat here for
 * weeks and never matched anything, because it is a PatternFly 5 name that a
 * mechanical `v5` → `v6` swap carried across. CI now checks every name below
 * against the stylesheet pinned in package.json, which is the only way to tell
 * a working class name from a dead one.
 */

/** Utility classes. */
export const CSS = {
  /** Secondary text colour, for de-emphasised detail. */
  textSecondary: 'pf-v6-u-text-color-subtle',
  fontSizeSm: 'pf-v6-u-font-size-sm',
  marginTopSm: 'pf-v6-u-mt-sm',
  marginTopMd: 'pf-v6-u-mt-md',
  marginBottomMd: 'pf-v6-u-mb-md',
} as const;

/** Design tokens, as ready-to-use `var(...)` expressions. */
export const TOKEN = {
  statusDanger: 'var(--pf-t--global--text--color--status--danger--default)',
  statusWarning: 'var(--pf-t--global--text--color--status--warning--default)',
  statusSuccess: 'var(--pf-t--global--text--color--status--success--default)',
  backgroundSecondary:
    'var(--pf-t--global--background--color--secondary--default)',
  spacerMd: 'var(--pf-t--global--spacer--md)',
  /**
   * Fills for the history panels' SVG. The *icon* status tokens, not the text
   * ones above: an icon is a filled shape, which is what a bar is, while the
   * text colours are tuned for legibility against a background rather than for
   * being the background.
   */
  fillDanger: 'var(--pf-t--global--icon--color--status--danger--default)',
  fillSuccess: 'var(--pf-t--global--icon--color--status--success--default)',
  borderSubtle: 'var(--pf-t--global--border--color--nonstatus--gray--default)',
} as const;
