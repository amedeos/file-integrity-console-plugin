import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Flex, FlexItem } from '@patternfly/react-core';
import { Timestamp } from '../lib/k8s';
import { I18N_NS } from '../constants';
import { CSS, TOKEN } from '../lib/styles';
import { LegendItem } from './LegendItem';
import { resolution, splitAtGaps, stepMillis, stepPaths } from '../lib/series';
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
 *
 * A fourth thing, found later and worse than the other three because it was a
 * statement rather than an omission: **the line ran straight through periods
 * nobody measured.** A step line holds its value until the next sample, which
 * is right while there is a next sample and becomes a claim about the night the
 * cluster was switched off. The line now breaks, and the stretch it skips is
 * marked and named.
 */
export const FailingNodesSparkline: React.FC<{
  samples: Sample[];
  beginsAt?: number;
  /** Set when fewer points came back than the window asked for. */
  sparse?: { returned: number; requested: number };
  timespan: Timespan;
}> = ({ samples, beginsAt, sparse, timespan }) => {
  const { t } = useTranslation(I18N_NS);

  const from = samples.at(0)?.t;
  const to = samples.at(-1)?.t;
  const peak = Math.max(...samples.map((s) => s.value), 1);
  const paths = stepPaths(samples, {
    width: WIDTH,
    height: HEIGHT,
    peak,
    step: stepMillis(timespan),
  });

  if (from === undefined || to === undefined || paths.length === 0) {
    return (
      <span className={CSS.textSecondary}>
        {t('No samples in this window yet.')}
      </span>
    );
  }

  // Whatever lies between one path and the next was not measured. Both come
  // out of the same split, so the shaded stretch, the break in the line and
  // the times in the tooltip cannot disagree about where the data stops.
  const runs = splitAtGaps(samples, stepMillis(timespan));
  const gaps = paths.slice(1).map((path, index) => ({
    x: paths[index].to,
    width: path.from - paths[index].to,
    from: runs[index]?.at(-1)?.t ?? 0,
    to: runs[index + 1]?.at(0)?.t ?? 0,
  }));

  const latest = samples.at(-1)?.value ?? 0;

  const windowLabel: Record<Timespan, string> = {
    '24h': t('the last 24 hours'),
    '7d': t('the last 7 days'),
    '30d': t('the last 30 days'),
  };

  const grain = resolution(timespan);
  const grainLabel =
    grain.unit === 'hours'
      ? t('One sample every {{count}} hour(s).', { count: grain.value })
      : t('One sample every {{count}} minute(s).', { count: grain.value });

  const summary = [
    t(
      'Between 0 and {{peak}} nodes were reporting changes during {{window}}; {{latest}} at the last sample.',
      { peak, latest, window: windowLabel[timespan] },
    ),
    gaps.length === 0
      ? ''
      : t('Nothing was collected during {{count}} period(s).', {
          count: gaps.length,
        }),
  ]
    .filter(Boolean)
    .join(' ');

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
            {gaps.map((gap) => (
              <rect
                key={gap.from}
                x={gap.x}
                width={Math.max(gap.width, 2)}
                y={0}
                height={HEIGHT}
                fill={TOKEN.fillUnknown}
                fillOpacity={0.25}
              >
                <title>
                  {t('Not collected, {{range}}', {
                    range: `${new Date(gap.from).toLocaleString()} — ${new Date(
                      gap.to,
                    ).toLocaleString()}`,
                  })}
                </title>
              </rect>
            ))}
            {paths.map((path) => (
              <React.Fragment key={path.from}>
                <polygon
                  points={`${path.points} ${path.to},${HEIGHT} ${path.from},${HEIGHT}`}
                  fill={TOKEN.fillDanger}
                  fillOpacity={0.15}
                />
                <polyline
                  points={path.points}
                  fill="none"
                  stroke={TOKEN.fillDanger}
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
              </React.Fragment>
            ))}
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
        {/*
          The last sample, not the word "now": collection stopping is exactly
          the case this panel now draws, and an axis that says "now" over the
          end of the data contradicts the break in the line beside it.
        */}
        <FlexItem>
          <Timestamp timestamp={new Date(to).toISOString()} />
        </FlexItem>
      </Flex>

      <Flex
        spaceItems={{ default: 'spaceItemsLg' }}
        className={`${CSS.marginTopSm} ${CSS.fontSizeSm} ${CSS.textSecondary}`}
      >
        {gaps.length === 0 ? null : (
          <FlexItem>
            <LegendItem colour={TOKEN.fillUnknown} label={t('Not collected')} />
          </FlexItem>
        )}
        <FlexItem>{grainLabel}</FlexItem>
      </Flex>

      <p className={CSS.marginTopSm}>{summary}</p>

      {beginsAt === undefined ? null : (
        <p className={`${CSS.fontSizeSm} ${CSS.textSecondary}`}>
          {t('This window begins at {{when}}: nothing earlier came back.', {
            when: new Date(beginsAt).toLocaleString(),
          })}
        </p>
      )}

      {sparse === undefined ? null : (
        <p className={`${CSS.fontSizeSm} ${CSS.textSecondary}`}>
          {t(
            '{{returned}} of the {{requested}} points asked for came back, so this band is a sample rather than a record.',
            sparse,
          )}
        </p>
      )}
    </>
  );
};
