/**
 * Prometheus queries, and turning their answers into something drawable.
 *
 * Everything here is pure, deliberately. The panels themselves are inline SVG,
 * and jsdom measures every element as zero-sized, so no test can judge what
 * they look like. So all the arithmetic that can be got wrong lives here
 * instead, where it can be tested properly, and the components are left with
 * nothing to decide.
 *
 * The queries were each run against a real cluster before being written down —
 * including the ones that look obviously right. `sum by (by) (...)` is the
 * example worth keeping in mind: `by` is both a PromQL keyword and the name of
 * the label on the re-init counter, and whether that parses is not a thing to
 * reason about from first principles.
 */
import { METRICS } from '../constants';
import type { PrometheusResponse } from './k8s';

/**
 * The windows the user can choose between.
 *
 * These strings are also valid PromQL range durations, which is why they are
 * spelled this way and interpolated directly into `increase(...[24h])` below.
 */
export type Timespan = '24h' | '7d' | '30d';

export const TIMESPANS: readonly Timespan[] = ['24h', '7d', '30d'] as const;

const HOUR_MS = 60 * 60 * 1000;

const TIMESPAN_MS: Record<Timespan, number> = {
  '24h': 24 * HOUR_MS,
  '7d': 7 * 24 * HOUR_MS,
  '30d': 30 * 24 * HOUR_MS,
};

/** Milliseconds, which is the unit `usePrometheusPoll` takes. */
export const timespanMillis = (timespan: Timespan): number =>
  TIMESPAN_MS[timespan];

/**
 * Points to request across the window. The console divides the timespan by
 * this to get the step, so it also sets the resolution of the strip: 120 over
 * 24 hours is a point every 12 minutes, and over 30 days one every 6 hours.
 */
export const SAMPLES = 120;

/** Step between points, in milliseconds. */
export const stepMillis = (timespan: Timespan): number =>
  timespanMillis(timespan) / SAMPLES;

/**
 * A PromQL string literal.
 *
 * A node name cannot contain a quote or a backslash, so this escapes nothing in
 * practice — but interpolating a value into a query without escaping it is a
 * habit rather than a decision, and this is the wrong repository to acquire it.
 */
export const promLiteral = (value: string): string =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export const queries = {
  /**
   * Is anything collecting the operator's metrics at all?
   *
   * This is the availability probe, and it deliberately filters on nothing. A
   * per-node query cannot answer it: `node_failed{node="x"}` is also empty when
   * that particular node has no metric yet, which is a different situation with
   * a different remedy. Empty here, and only here, means nobody is scraping.
   */
  scraped: (): string => `count(${METRICS.nodeFailed})`,

  /**
   * One node's 0/1 gauge. `max by (node)` collapses the series the operator's
   * pod identity would otherwise multiply: restart it and the old series is
   * joined by a new one with a different `pod` and `instance`.
   */
  nodeFailed: (node: string): string =>
    `max by (node) (${METRICS.nodeFailed}{node=${promLiteral(node)}})`,

  /** How many nodes are failing: the inner max collapses pods, the sum counts nodes. */
  failingNodes: (): string => `sum(max by (node) (${METRICS.nodeFailed}))`,

  /**
   * How many times a node entered the failed state in the window.
   *
   * `increase` extrapolates, so it answers 1.0172744767338133 where a person
   * means 1 — observed, not guessed. `round` is what makes it a count again.
   */
  nodeFailures: (node: string, timespan: Timespan): string =>
    `round(sum(increase(${METRICS.nodeStatus}{node=${promLiteral(node)},condition="Failed"}[${timespan}])))`,

  /** Re-inits in the window, split by what caused them. */
  reinits: (timespan: Timespan): string =>
    `round(sum by (by) (increase(${METRICS.reinit}[${timespan}])))`,
};

/** One point of a range query. `t` is milliseconds since the epoch. */
export interface Sample {
  t: number;
  value: number;
}

/**
 * Whether the response carries any series at all.
 *
 * Empty is not zero. A counter that has never been incremented does not exist,
 * so `reinit_total` is absent on a cluster where nobody has re-initialised
 * anything — which must read as "none", not as "no data". Only the availability
 * probe gets to treat empty as a problem.
 */
export const hasSeries = (response?: PrometheusResponse): boolean =>
  (response?.data.result.length ?? 0) > 0;

const toNumber = (raw: unknown): number => {
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
};

/** The scalar of an instant query; 0 when the series does not exist. */
export const instantValue = (response?: PrometheusResponse): number =>
  toNumber(response?.data.result.at(0)?.value?.[1]);

/**
 * Instant values keyed by one of their labels, summed when several series
 * share a key.
 */
export const instantByLabel = (
  response: PrometheusResponse | undefined,
  label: string,
): Record<string, number> => {
  const out: Record<string, number> = {};
  (response?.data.result ?? []).forEach((series) => {
    const key = series.metric[label];
    if (typeof key === 'string') {
      out[key] = (out[key] ?? 0) + toNumber(series.value?.[1]);
    }
  });
  return out;
};

/**
 * The points of a range query, oldest first.
 *
 * Takes the first series only: every range query here aggregates away the
 * labels that could produce a second one, so a second series would mean the
 * query was wrong rather than that the data needs merging.
 */
export const rangeSamples = (response?: PrometheusResponse): Sample[] =>
  (response?.data.result.at(0)?.values ?? []).map(([t, value]) => ({
    t: toNumber(t) * 1000,
    value: toNumber(value),
  }));

/**
 * Where the data actually begins, when that is later than what was asked for.
 *
 * This is the whole reason the window selector needed care. Prometheus does not
 * refuse a range it cannot fill, it just answers with less of it — and a strip
 * that quietly starts three days in reads as three quiet days, which is worse
 * than showing nothing. Two steps of tolerance, so ordinary scrape misalignment
 * at the left edge is not reported as a gap.
 *
 * **Why it begins late is not knowable from here, and the panel used to say it
 * was retention.** It can equally be that nothing was collected before then —
 * on the lab, that the cluster had not been built yet. The two were told apart
 * by the windows contradicting each other: 30 days reported a *later* start
 * than 7 days, which retention cannot produce. See `returnedFraction` below for
 * what does produce it.
 *
 * The window is measured back from the last sample rather than from the
 * clock, so this needs no notion of "now": the caller does not have to know
 * what instant the console asked Prometheus about, and a skewed browser clock
 * cannot invent a gap.
 *
 * Returns undefined when the range is covered, or when there is nothing to say
 * because there are no samples at all.
 */
export const dataBeginsAt = (
  samples: Sample[],
  timespan: number,
  step: number,
): number | undefined => {
  const first = samples.at(0)?.t;
  const last = samples.at(-1)?.t;
  if (first === undefined || last === undefined) {
    return undefined;
  }
  return first > last - timespan + 2 * step ? first : undefined;
};

/**
 * How much time one sample stands for.
 *
 * The window selector changes this by a factor of thirty and says nothing about
 * it, which is the difference between reading a band as an incident and reading
 * it as noise: over 24 hours a single failing sample is twelve minutes, over 30
 * days it is six hours of strip. The panels state it, and this is where the
 * arithmetic lives so it can be tested rather than trusted.
 */
export interface Resolution {
  value: number;
  unit: 'minutes' | 'hours';
}

export const resolution = (timespan: Timespan): Resolution => {
  const minutes = Math.round(stepMillis(timespan) / 60000);
  return minutes >= 120 && minutes % 60 === 0
    ? { value: minutes / 60, unit: 'hours' }
    : { value: minutes, unit: 'minutes' };
};

/**
 * Whether the window came back as full as it was asked for.
 *
 * A range query answers at a grid of instants and puts a point at one only if a
 * sample exists within Prometheus's five-minute lookback of it. Where
 * collection is continuous every instant finds one and the answer is complete,
 * which is why this is silent on a healthy cluster. Where it is intermittent
 * the grid mostly falls in the dark, and the coarser the step the worse it
 * gets: measured on the lab against one node, 22 points of 121 over 24 hours,
 * **4 over 7 days and 1 over 30**.
 *
 * A band drawn from one point is not a coarse history, it is a sample of one
 * presented at full width — and it is not even stable, since the grid moves
 * with the clock: shifting the end of the same 30-day window by an hour turned
 * one point into three and moved the reported start by a day. That instability
 * is what proved the "monitoring does not retain the whole window" sentence
 * wrong, and this is the fact that belongs in its place.
 *
 * Returns undefined when the window is as full as asked, so the panels say
 * nothing when there is nothing to warn about.
 */
export const returnedFraction = (
  samples: Sample[],
  requested = SAMPLES,
): { returned: number; requested: number } | undefined =>
  samples.length < requested
    ? { returned: samples.length, requested }
    : undefined;

/**
 * How far apart two samples have to be before the space between them is an
 * absence rather than the ordinary spacing.
 *
 * Prometheus answers a range query at every step where the series was alive,
 * and omits the steps where it was not — so consecutive entries in the array
 * are *not* consecutive in time, and treating them as such is the whole defect
 * this constant exists to fix. One missing point already means at least a
 * step's worth of nothing, so the threshold sits between one step and two
 * rather than being generous: a scrape that merely stutters does not lose a
 * point at all, because Prometheus looks back five minutes for one.
 */
const GAP_STEPS = 1.5;

/**
 * The samples split into runs, broken wherever collection stopped.
 *
 * Every drawing function goes through this, so none of them can accidentally
 * join two sides of a gap — which is what each of them used to do.
 */
export const splitAtGaps = (samples: Sample[], step: number): Sample[][] => {
  const runs: Sample[][] = [];
  let previous: number | undefined;
  samples.forEach((sample) => {
    if (previous === undefined || sample.t - previous > GAP_STEPS * step) {
      runs.push([]);
    }
    runs.at(-1)?.push(sample);
    previous = sample.t;
  });
  return runs;
};

/**
 * The stretch of time a panel draws, which is the *window* and not the data.
 *
 * This is the correction to the mistake that produced the whole of this
 * section. Both panels used to run their coordinate space from the first
 * sample to the last, so whatever came back filled the width: on the lab the
 * 30-day window returned a single point and the band drew a month of green
 * from an observation taken that afternoon. A window is a fixed length of
 * time, and a band that rescales to its contents cannot be read at all — the
 * same picture means one thing at 120 points and another at one.
 *
 * The window's start is `(last sample + one step) − window`, so this needs no
 * clock: the last sample is the right-hand edge by construction, exactly as
 * `dataBeginsAt` already assumed. Having written that this was impossible
 * without knowing the time is what left the rescaling in place for a week.
 *
 * The head is only widened when `dataBeginsAt` says the data starts late — the
 * same test, deliberately, so the grey stretch at the left and the sentence
 * underneath it can never disagree about whether there is one.
 */
export const plotSpan = (
  samples: Sample[],
  step: number,
  window?: number,
): { from: number; to: number } | undefined => {
  const first = samples.at(0)?.t;
  const last = samples.at(-1)?.t;
  if (first === undefined || last === undefined) {
    return undefined;
  }
  // A sample stands for the step that follows it, so the drawn extent reaches
  // one step past the last one — which is also what makes a lone sample have a
  // width at all.
  const to = last + step;
  if (
    window !== undefined &&
    dataBeginsAt(samples, window, step) !== undefined
  ) {
    return { from: to - window, to };
  }
  return { from: first, to };
};

/** What a strip is made of: a measured run, or a stretch of nothing. */
export type SegmentState = 'failed' | 'ok' | 'gap';

/** A run of consecutive samples sharing a state. */
export interface Segment {
  from: number;
  to: number;
  state: SegmentState;
}

/** One unbroken stretch of the count line, and the x range it occupies. */
export interface StepPath {
  points: string;
  from: number;
  to: number;
}

/**
 * A count series as SVG polyline points, drawn as **steps** rather than as a
 * line between sample centres, and **broken wherever collection stopped**.
 *
 * The values are counts of nodes, and a count does not slide from two to three:
 * it was two until a scrape said otherwise. Joining the points diagonally draws
 * a change that never happened and, worse, puts the transition at the wrong
 * time — halfway between the two scrapes instead of at the second one. So each
 * sample holds its value until the next, and the line turns vertically.
 *
 * Holding a value until the next sample is right *while there is a next
 * sample*. Across a gap it becomes a claim about hours nobody measured — the
 * line ran flat through the night the lab was switched off, saying two nodes
 * were failing throughout. Hence one path per run rather than one for the
 * series, and hence each path carrying its own x range: the caller closes the
 * area under it to the baseline, and needs to know where it starts and ends to
 * do that without inventing corners.
 *
 * `peak` is the top of the scale, passed in rather than derived here because
 * the caller also has to label it. Zero or negative would divide by nothing, so
 * it is floored at one — a series of all zeroes then draws flat along the
 * bottom, which is the truth.
 *
 * **A run reaches one step past its last sample**, which is what `toSegments`
 * has always done next door and what this used to leave out. It matters twice:
 * the two panels drew the same data at two different widths, and a run of one
 * sample had no width at all. That last case is not hypothetical — it is what
 * a 30-day window returned on the lab, and the panel reported it as an empty
 * window while the band beside it drew the same point across a month.
 *
 * Returns an empty array only when there are no samples. One sample is a
 * drawable thing; saying otherwise was the defect.
 */
export const stepPaths = (
  samples: Sample[],
  plot: {
    width: number;
    height: number;
    peak: number;
    step: number;
    /** The window asked for, so a short answer draws short. See `plotSpan`. */
    window?: number;
  },
): StepPath[] => {
  const span = plotSpan(samples, plot.step, plot.window);
  if (span === undefined) {
    return [];
  }
  const width = span.to - span.from;
  const peak = Math.max(plot.peak, 1);
  const scaleX = (t: number) => ((t - span.from) / width) * plot.width;

  return splitAtGaps(samples, plot.step).map((run) => {
    const points: string[] = [];
    let previousY: number | undefined;
    run.forEach((sample) => {
      const x = scaleX(sample.t);
      const y = plot.height - (sample.value / peak) * plot.height;
      if (previousY !== undefined && previousY !== y) {
        points.push(`${x.toFixed(2)},${previousY.toFixed(2)}`);
      }
      points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
      previousY = y;
    });
    const start = run.at(0)?.t ?? span.from;
    const end = (run.at(-1)?.t ?? span.from) + plot.step;
    if (previousY !== undefined) {
      points.push(`${scaleX(end).toFixed(2)},${previousY.toFixed(2)}`);
    }
    return {
      points: points.join(' '),
      from: scaleX(start),
      to: scaleX(end),
    };
  });
};

/**
 * Collapses samples into runs, which is what the strip draws.
 *
 * A segment ends one step after its last sample, so the final run covers the
 * width it represents instead of stopping at a point. The gauge is 0 or 1 and
 * anything above zero counts as failing, which also makes this correct for the
 * cluster-wide sum where the value is a count of failing nodes.
 *
 * **A gap is a third state, not the absence of one.** Merging two samples that
 * happen to be adjacent in the array painted the hours between them in the
 * colour of whichever state surrounded them, so a band claimed a node had been
 * failing all night when the truth was that nothing had been asked. That is
 * worse than incomplete: it is an assertion about a period nobody measured.
 * When the two sides disagreed the gap was instead left blank — which is honest
 * by accident and unreadable by design, since nothing said what blank meant.
 *
 * **The head of the window is a gap like any other**, and pass `window` to have
 * it drawn as one. Without it the first segment starts at the first sample and
 * the band silently rescales, so a window that came back a tenth full still
 * fills its width; the grey head is what makes a sparse window look sparse
 * rather than merely coarse.
 */
export const toSegments = (
  samples: Sample[],
  step: number,
  window?: number,
): Segment[] => {
  const segments: Segment[] = [];
  splitAtGaps(samples, step).forEach((run) => {
    const previousEnd = segments.at(-1)?.to;
    const start = run.at(0)?.t;
    if (previousEnd !== undefined && start !== undefined) {
      segments.push({ from: previousEnd, to: start, state: 'gap' });
    }
    run.forEach((sample) => {
      const state: SegmentState = sample.value > 0 ? 'failed' : 'ok';
      const last = segments.at(-1);
      if (last?.state === state) {
        last.to = sample.t + step;
      } else {
        segments.push({ from: sample.t, to: sample.t + step, state });
      }
    });
  });

  const span = plotSpan(samples, step, window);
  const first = segments.at(0)?.from;
  if (span !== undefined && first !== undefined && span.from < first) {
    segments.unshift({ from: span.from, to: first, state: 'gap' });
  }
  return segments;
};

/** A stretch nobody measured, both in time and in the plot's own coordinates. */
export interface GapBand {
  from: number;
  to: number;
  x: number;
  width: number;
}

/**
 * The uncollected stretches of a plot, ready to be drawn over it.
 *
 * The band gets these for free — they are its grey segments — and the line
 * chart used to work them out for itself, from the space left between one path
 * and the next. That could only ever find a gap *between* two runs, so the head
 * of a window that begins late was drawn by neither panel. Both now come from
 * the same `toSegments` call, which is also the only way the shaded stretch,
 * the break in the line and the times in the tooltip cannot drift apart.
 */
export const gapBands = (
  samples: Sample[],
  plot: { width: number; step: number; window?: number },
): GapBand[] => {
  const span = plotSpan(samples, plot.step, plot.window);
  if (span === undefined) {
    return [];
  }
  const scaleX = (t: number) =>
    ((t - span.from) / (span.to - span.from)) * plot.width;

  return toSegments(samples, plot.step, plot.window)
    .filter((segment) => segment.state === 'gap')
    .map((segment) => ({
      from: segment.from,
      to: segment.to,
      x: scaleX(segment.from),
      width: scaleX(segment.to) - scaleX(segment.from),
    }));
};
