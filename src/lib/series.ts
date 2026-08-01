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
 * This is the whole reason the window selector needed care. Past the cluster's
 * retention Prometheus does not refuse the range, it just answers with less of
 * it — and a strip that quietly starts three days in reads as three quiet days,
 * which is worse than showing nothing. Two steps of tolerance, so ordinary
 * scrape misalignment at the left edge is not reported as a gap.
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

/** A run of consecutive samples sharing a state. */
export interface Segment {
  from: number;
  to: number;
  failed: boolean;
}

/**
 * Collapses samples into runs, which is what the strip draws.
 *
 * A segment ends one step after its last sample, so the final run covers the
 * width it represents instead of stopping at a point. The gauge is 0 or 1 and
 * anything above zero counts as failing, which also makes this correct for the
 * cluster-wide sum where the value is a count of failing nodes.
 */
export const toSegments = (samples: Sample[], step: number): Segment[] => {
  const segments: Segment[] = [];
  samples.forEach((sample) => {
    const failed = sample.value > 0;
    const last = segments.at(-1);
    if (last?.failed === failed) {
      last.to = sample.t + step;
    } else {
      segments.push({ from: sample.t, to: sample.t + step, failed });
    }
  });
  return segments;
};
