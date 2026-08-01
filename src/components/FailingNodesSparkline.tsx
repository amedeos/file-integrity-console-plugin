import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Flex, FlexItem } from '@patternfly/react-core';
import { Timestamp } from '../lib/k8s';
import { I18N_NS } from '../constants';
import { CSS, TOKEN } from '../lib/styles';
import type { Sample, Timespan } from '../lib/series';

/**
 * How many nodes were reporting changes, over time — the history of the count
 * cards immediately above it on the overview.
 *
 * Inline SVG, for the same reason as the band next door. The vertical scale is
 * the highest point in the window rather than the cluster's node count: what
 * matters is the shape, and a cluster of two hundred nodes with three failing
 * would otherwise draw a flat line along the bottom.
 */
export const FailingNodesSparkline: React.FC<{
  samples: Sample[];
  beginsAt?: number;
  timespan: Timespan;
}> = ({ samples, beginsAt, timespan }) => {
  const { t } = useTranslation(I18N_NS);

  const from = samples.at(0)?.t;
  const to = samples.at(-1)?.t;

  if (from === undefined || to === undefined || to <= from) {
    return (
      <span className={CSS.textSecondary}>
        {t('No samples in this window yet.')}
      </span>
    );
  }

  const span = to - from;
  const peak = Math.max(...samples.map((s) => s.value), 1);
  const latest = samples.at(-1)?.value ?? 0;

  const points = samples
    .map((sample) => {
      const x = ((sample.t - from) / span) * 1000;
      const y = 60 - (sample.value / peak) * 56;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  const windowLabel: Record<Timespan, string> = {
    '24h': t('the last 24 hours'),
    '7d': t('the last 7 days'),
    '30d': t('the last 30 days'),
  };

  const summary = t(
    'Between 0 and {{peak}} nodes were reporting changes during {{window}}; {{latest}} now.',
    { peak, latest, window: windowLabel[timespan] },
  );

  return (
    <>
      <svg
        viewBox="0 0 1000 60"
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
        style={{
          width: '100%',
          height: '60px',
          borderBottom: `1px solid ${TOKEN.borderSubtle}`,
        }}
      >
        <polyline
          points={points}
          fill="none"
          stroke={TOKEN.fillDanger}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <Flex
        justifyContent={{ default: 'justifyContentSpaceBetween' }}
        className={`${CSS.marginTopSm} ${CSS.fontSizeSm} ${CSS.textSecondary}`}
      >
        <FlexItem>
          <Timestamp timestamp={new Date(from).toISOString()} />
        </FlexItem>
        <FlexItem>{t('peak {{peak}}', { peak })}</FlexItem>
        <FlexItem>{t('now')}</FlexItem>
      </Flex>

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
