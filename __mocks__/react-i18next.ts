import type { FC, PropsWithChildren } from 'react';

/**
 * `t` returns the key, with the interpolations substituted into it.
 *
 * Returning the key alone was simpler and cost more than it saved: every
 * sentence carrying a number came out of a test as `{{count}}`, so three tests
 * said in their own comments that the numbers were "not assertable here" — and
 * a panel could have reported any figure at all without a test noticing. The
 * number is the part a reader acts on.
 *
 * It is not i18next. There is no catalogue, no plural selection and no
 * formatting: the key *is* the English text, which is what the catalogue holds
 * anyway, and `{{name}}` is replaced by whatever the options object carries
 * under that name. An interpolation with no matching option is left standing,
 * so a misspelt one shows up as itself rather than as a blank.
 */
export const useTranslation = () => ({
  t: (key: string, options?: Record<string, unknown>) =>
    options === undefined
      ? key
      : key.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
          name in options ? String(options[name]) : whole,
        ),
});

export const Trans: FC<PropsWithChildren> = ({ children }) => children;
