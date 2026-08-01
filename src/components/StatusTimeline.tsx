import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Flex, FlexItem } from '@patternfly/react-core';
import { Timestamp } from '../lib/k8s';
import { I18N_NS } from '../constants';
import { CSS, TOKEN } from '../lib/styles';
import type { Segment, Timespan } from '../lib/series';

/**
 * One node's integrity over time: a band, red where AIDE was reporting changes
 * and green where it was not.
 *
 * Inline SVG rather than a charting library. A 0/1 gauge over one axis is a row
 * of rectangles, and `@patternfly/react-charts` would mean a new dependency
 * pinned three times across three PatternFly majors, with Victory underneath —
 * a cost this repository has already paid twice for less.
 *
 * The band carries an `aria-label` saying in words what it shows. That is not
 * only for screen readers: jsdom measures every element as zero-sized, so the
 * label is the only part of this a test can meaningfully assert.
 */
export const StatusTimeline: React.FC<{
  segments: Segment[];
  beginsAt?: number;
  failures: number;
  timespan: Timespan;
}> = ({ segments, beginsAt, failures, timespan }) => {
  const { t } = useTranslation(I18N_NS);

  const from = segments.at(0)?.from;
  const to = segments.at(-1)?.to;

  if (from === undefined || to === undefined || to <= from) {
    return (
      <span className={CSS.textSecondary}>
        {t('No samples in this window yet.')}
      </span>
    );
  }

  const span = to - from;
  const failing = segments.filter((s) => s.failed);

  const windowLabel: Record<Timespan, string> = {
    '24h': t('the last 24 hours'),
    '7d': t('the last 7 days'),
    '30d': t('the last 30 days'),
  };

  const summary =
    failing.length === 0
      ? t('No changes detected on this node during {{window}}.', {
          window: windowLabel[timespan],
        })
      : t('Changes were being reported during {{count}} period(s).', {
          count: failing.length,
        });

  return (
    <>
      <svg
        viewBox="0 0 1000 24"
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
        style={{
          width: '100%',
          height: '24px',
          border: `1px solid ${TOKEN.borderSubtle}`,
        }}
      >
        {segments.map((segment) => (
          <rect
            key={segment.from}
            x={((segment.from - from) / span) * 1000}
            // At least a hairline: a single failing sample in a 30-day window
            // is a fraction of a pixel wide, and the one thing this band must
            // never do is hide a failure by rounding it away.
            width={Math.max(((segment.to - segment.from) / span) * 1000, 2)}
            y={0}
            height={24}
            fill={segment.failed ? TOKEN.fillDanger : TOKEN.fillSuccess}
          />
        ))}
      </svg>

      <Flex
        justifyContent={{ default: 'justifyContentSpaceBetween' }}
        className={`${CSS.marginTopSm} ${CSS.fontSizeSm} ${CSS.textSecondary}`}
      >
        <FlexItem>
          <Timestamp timestamp={new Date(from).toISOString()} />
        </FlexItem>
        <FlexItem>{t('now')}</FlexItem>
      </Flex>

      <p className={CSS.marginTopSm}>
        {summary}{' '}
        {failures > 0
          ? t('Entered the failed state {{count}} time(s) in this window.', {
              count: failures,
            })
          : null}
      </p>

      {beginsAt === undefined ? null : (
        <p className={`${CSS.fontSizeSm} ${CSS.textSecondary}`}>
          {t(
            'Data begins at {{when}}: the cluster’s monitoring does not retain the whole window.',
            { when: new Date(beginsAt).toLocaleString() },
          )}
        </p>
      )}
    </>
  );
};
