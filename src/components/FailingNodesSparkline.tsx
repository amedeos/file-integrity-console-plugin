import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Flex, FlexItem } from '@patternfly/react-core';
import { Timestamp } from '../lib/k8s';
import { I18N_NS } from '../constants';
import { CSS, TOKEN } from '../lib/styles';
import { stepPoints } from '../lib/series';
import type { Sample, Timespan } from '../lib/series';

const WIDTH = 1000;
const HEIGHT = 60;

/**
 * How many nodes were reporting changes, over time — the history of the count
 * cards immediately above it on the overview.
 *
 * Inline SVG, for the same reason as the band next door.
 *
 * Three things the first version got wrong, all of them the same mistake — a
 * line with nothing around it is not a chart:
 *
 * - **No scale.** The vertical axis runs from zero to the highest point in the
 *   window, which is right (a cluster of two hundred nodes with three failing
 *   would otherwise draw a flat line along the bottom) — but with neither end
 *   labelled, a constant series drew a straight rule across the top that was
 *   indistinguishable from a border. Both ends are now written beside it.
 * - **No area.** A single series over time is an area, not a bare stroke: the
 *   fill is what makes "two nodes, all day" read as a quantity instead of as a
 *   horizontal line somewhere on the card.
 * - **A number in the middle of the time axis.** `peak` sat between the start
 *   time and *now*, where a reader expects a middle timestamp. It belongs to
 *   the vertical scale, and that is where it went.
 *
 * The summary sentence is also rendered rather than only spoken: it was the
 * `aria-label` alone, which is precisely backwards — a chart that needs a
 * sentence needs it on the screen.
 */
export const FailingNodesSparkline: React.FC<{
  samples: Sample[];
  beginsAt?: number;
  timespan: Timespan;
}> = ({ samples, beginsAt, timespan }) => {
  const { t } = useTranslation(I18N_NS);

  const from = samples.at(0)?.t;
  const to = samples.at(-1)?.t;
  const peak = Math.max(...samples.map((s) => s.value), 1);
  const points = stepPoints(samples, {
    width: WIDTH,
    height: HEIGHT,
    peak,
  });

  if (from === undefined || to === undefined || !points) {
    return (
      <span className={CSS.textSecondary}>
        {t('No samples in this window yet.')}
      </span>
    );
  }

  const latest = samples.at(-1)?.value ?? 0;

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
      <Flex
        spaceItems={{ default: 'spaceItemsSm' }}
        flexWrap={{ default: 'nowrap' }}
        alignItems={{ default: 'alignItemsStretch' }}
      >
        {/*
          The scale is written in HTML beside the plot rather than as SVG text
          inside it. The plot is stretched to the card's width with
          preserveAspectRatio="none", which would stretch any glyph in it with
          the same factor — a label that changes shape as the panel is resized.
        */}
        <FlexItem>
          <Flex
            direction={{ default: 'column' }}
            justifyContent={{ default: 'justifyContentSpaceBetween' }}
            className={`${CSS.fontSizeSm} ${CSS.textSecondary}`}
            style={{ height: `${HEIGHT}px` }}
          >
            <FlexItem>{peak}</FlexItem>
            <FlexItem>0</FlexItem>
          </Flex>
        </FlexItem>
        <FlexItem grow={{ default: 'grow' }}>
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={summary}
            style={{
              width: '100%',
              height: `${HEIGHT}px`,
              borderBottom: `1px solid ${TOKEN.borderSubtle}`,
            }}
          >
            <polygon
              points={`${points} ${WIDTH},${HEIGHT} 0,${HEIGHT}`}
              fill={TOKEN.fillDanger}
              fillOpacity={0.15}
            />
            <polyline
              points={points}
              fill="none"
              stroke={TOKEN.fillDanger}
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </FlexItem>
      </Flex>

      <Flex
        justifyContent={{ default: 'justifyContentSpaceBetween' }}
        className={`${CSS.marginTopSm} ${CSS.fontSizeSm} ${CSS.textSecondary}`}
      >
        <FlexItem>
          <Timestamp timestamp={new Date(from).toISOString()} />
        </FlexItem>
        <FlexItem>{t('now')}</FlexItem>
      </Flex>

      <p className={CSS.marginTopSm}>{summary}</p>

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
