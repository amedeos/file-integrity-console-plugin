import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Flex, FlexItem } from '@patternfly/react-core';
import { Timestamp } from '../lib/k8s';
import { I18N_NS } from '../constants';
import { CSS, TOKEN } from '../lib/styles';
import { LegendItem } from './LegendItem';
import { resolution, stepMillis } from '../lib/series';
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
 * The legend is not decoration and not optional. A status colour never carries
 * meaning on its own — the first version of this band shipped without one, and
 * a node that had been failing all day drew a single red bar that said nothing
 * about what red was. Two swatches and two words are the whole fix.
 *
 * Each run also carries a `<title>`, which is the SVG element browsers surface
 * as a tooltip. It costs nothing, needs no library and no hover state, and it
 * is what turns "somewhere in there" into a pair of times.
 *
 * The third colour is the one that matters most, and it was missing. A period
 * nobody scraped used to be painted in whichever state surrounded it, so a band
 * asserted that a node had been failing all night when in truth the cluster had
 * been switched off — observed on the lab, and worse than an incomplete band
 * because it is a claim rather than a silence. Grey says nothing was collected,
 * and the legend says what grey is.
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
  const failing = segments.filter((s) => s.state === 'failed');
  const uncollected = segments.filter((s) => s.state === 'gap');

  const windowLabel: Record<Timespan, string> = {
    '24h': t('the last 24 hours'),
    '7d': t('the last 7 days'),
    '30d': t('the last 30 days'),
  };

  // Said out loud rather than left to the colours, because it changes what the
  // sentence before it is worth: "no changes detected" over a window a third of
  // which was never scraped is a claim about the third that was.
  const summary = [
    failing.length === 0
      ? t('No changes detected on this node during {{window}}.', {
          window: windowLabel[timespan],
        })
      : t('Changes were being reported during {{count}} period(s).', {
          count: failing.length,
        }),
    uncollected.length === 0
      ? ''
      : t('Nothing was collected during {{count}} period(s).', {
          count: uncollected.length,
        }),
  ]
    .filter(Boolean)
    .join(' ');

  const fill: Record<Segment['state'], string> = {
    failed: TOKEN.fillDanger,
    ok: TOKEN.fillSuccess,
    gap: TOKEN.fillUnknown,
  };

  const range = (segment: Segment) =>
    `${new Date(segment.from).toLocaleString()} — ${new Date(
      segment.to,
    ).toLocaleString()}`;

  const describe = (segment: Segment) => {
    const when = { range: range(segment) };
    if (segment.state === 'failed') {
      return t('Changes reported, {{range}}', when);
    }
    return segment.state === 'ok'
      ? t('No changes, {{range}}', when)
      : t('Not collected, {{range}}', when);
  };

  const grain = resolution(timespan);
  const grainLabel =
    grain.unit === 'hours'
      ? t('One sample every {{count}} hour(s).', { count: grain.value })
      : t('One sample every {{count}} minute(s).', { count: grain.value });

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
            fill={fill[segment.state]}
          >
            <title>{describe(segment)}</title>
          </rect>
        ))}
      </svg>

      <Flex
        justifyContent={{ default: 'justifyContentSpaceBetween' }}
        className={`${CSS.marginTopSm} ${CSS.fontSizeSm} ${CSS.textSecondary}`}
      >
        <FlexItem>
          <Timestamp timestamp={new Date(from).toISOString()} />
        </FlexItem>
        {/*
          The right end is the last sample, not the word "now". They are the
          same thing only while collection is current: stop scraping and
          Prometheus stops returning points, so the band ends where the data
          did — and labelling that "now" is the same lie as painting a gap.
          One step back from the band's edge, because a segment covers the step
          that follows its sample and a timestamp in the future reads as a bug.
        */}
        <FlexItem>
          <Timestamp
            timestamp={new Date(to - stepMillis(timespan)).toISOString()}
          />
        </FlexItem>
      </Flex>

      <Flex
        spaceItems={{ default: 'spaceItemsLg' }}
        className={`${CSS.marginTopSm} ${CSS.fontSizeSm} ${CSS.textSecondary}`}
      >
        <FlexItem>
          <LegendItem colour={TOKEN.fillDanger} label={t('Changes reported')} />
        </FlexItem>
        <FlexItem>
          <LegendItem colour={TOKEN.fillSuccess} label={t('No changes')} />
        </FlexItem>
        <FlexItem>
          <LegendItem colour={TOKEN.fillUnknown} label={t('Not collected')} />
        </FlexItem>
        <FlexItem>{grainLabel}</FlexItem>
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
