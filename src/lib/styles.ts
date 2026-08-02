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
  textSecondary: 'pf-v5-u-color-200',
  fontSizeSm: 'pf-v5-u-font-size-sm',
  marginTopSm: 'pf-v5-u-mt-sm',
  marginTopMd: 'pf-v5-u-mt-md',
  marginBottomMd: 'pf-v5-u-mb-md',
} as const;

/**
 * Design tokens, as ready-to-use `var(...)` expressions.
 *
 * PatternFly 6's semantic tokens have no equivalent here: version 5 exposes the
 * palette directly, so these are the nearest values rather than the same ones,
 * and this generation will not look pixel-identical to 4.22. That is a
 * consequence of the console's own stylesheet, not something a plugin can fix.
 *
 * The floor of this branch is what these have to satisfy: consoles 4.16 and
 * 4.17 load `@patternfly/patternfly` 5.2.1, 4.18 loads 5.4.0. Every name below
 * is present in 5.2.
 */
export const TOKEN = {
  statusDanger: 'var(--pf-v5-global--danger-color--100)',
  statusWarning: 'var(--pf-v5-global--warning-color--100)',
  statusSuccess: 'var(--pf-v5-global--success-color--100)',
  backgroundSecondary: 'var(--pf-v5-global--BackgroundColor--200)',
  spacerMd: 'var(--pf-v5-global--spacer--md)',
  /**
   * Fills for the history panels' SVG.
   *
   * On `main` these are the *icon* status tokens, deliberately not the text
   * ones above: PatternFly 6 tunes the text colours for legibility against a
   * background rather than for being the background. Version 5 draws no such
   * distinction — it exposes the palette directly and both uses read the same
   * entry — so here `fillDanger` and `statusDanger` are one colour, and that
   * is the stylesheet's doing rather than an oversight. Keep the two names
   * apart anyway: the components ask for the one they mean, and the day this
   * branch is dropped nothing has to be renamed back.
   */
  fillDanger: 'var(--pf-v5-global--danger-color--100)',
  fillSuccess: 'var(--pf-v5-global--success-color--100)',
  /**
   * Where nothing was collected. Deliberately not a status colour: those four
   * are reserved for states the cluster was actually in, and "nobody was
   * looking" is not one of them. A grey has no hue to confuse with the two
   * beside it under any colour vision, because what separates it from them is
   * chroma rather than hue.
   *
   * PatternFly 5 offers three disabled greys where 6 offers one, and this is
   * the darkest of them rather than the nearest in lightness. `--200` is
   * #d2d2d2, which on a white card is a tint rather than a mark — and a grey
   * that can be mistaken for the unpainted background reintroduces exactly the
   * ambiguity this state was added to remove. The legend swatch is ten pixels
   * square and settles it.
   */
  fillUnknown: 'var(--pf-v5-global--disabled-color--100)',
  borderSubtle: 'var(--pf-v5-global--BorderColor--100)',
} as const;
