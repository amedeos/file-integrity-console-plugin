import type { PrometheusResponse } from './k8s';
import {
  SAMPLES,
  dataBeginsAt,
  hasSeries,
  instantByLabel,
  instantValue,
  promLiteral,
  queries,
  rangeSamples,
  resolution,
  returnedFraction,
  splitAtGaps,
  stepMillis,
  stepPaths,
  timespanMillis,
  toSegments,
} from './series';

const vector = (
  series: { labels?: Record<string, string>; value: string }[],
): PrometheusResponse =>
  ({
    status: 'success',
    data: {
      resultType: 'vector',
      result: series.map((s) => ({
        metric: s.labels ?? {},
        value: [0, s.value],
      })),
    },
  }) as unknown as PrometheusResponse;

const matrix = (values: [number, string][]): PrometheusResponse =>
  ({
    status: 'success',
    data: {
      resultType: 'matrix',
      result: [{ metric: {}, values }],
    },
  }) as unknown as PrometheusResponse;

const empty = (): PrometheusResponse =>
  ({
    status: 'success',
    data: { resultType: 'vector', result: [] },
  }) as unknown as PrometheusResponse;

describe('promLiteral', () => {
  it('quotes a plain value', () => {
    expect(promLiteral('control-plane-0')).toBe('"control-plane-0"');
  });

  it('escapes what would end the literal early', () => {
    expect(promLiteral('a"b')).toBe('"a\\"b"');
    expect(promLiteral('a\\b')).toBe('"a\\\\b"');
  });
});

describe('queries', () => {
  // These exact strings were run against a cluster before they were written
  // down. Pinning them here means an edit that looks harmless has to be run
  // against a cluster too, rather than merely type-checking.
  it('probes availability without filtering on anything', () => {
    expect(queries.scraped()).toBe(
      'count(file_integrity_operator_node_failed)',
    );
  });

  it('collapses the operator pod out of a per-node gauge', () => {
    expect(queries.nodeFailed('control-plane-0')).toBe(
      'max by (node) (file_integrity_operator_node_failed{node="control-plane-0"})',
    );
  });

  it('counts failing nodes rather than failing series', () => {
    expect(queries.failingNodes()).toBe(
      'sum(max by (node) (file_integrity_operator_node_failed))',
    );
  });

  it('rounds the extrapolation out of a failure count', () => {
    expect(queries.nodeFailures('n1', '7d')).toBe(
      'round(sum(increase(file_integrity_operator_node_status_total{node="n1",condition="Failed"}[7d])))',
    );
  });

  it('groups re-inits by the label that is also a keyword', () => {
    expect(queries.reinits('30d')).toBe(
      'round(sum by (by) (increase(file_integrity_operator_reinit_total[30d])))',
    );
  });
});

describe('hasSeries', () => {
  it.each([
    ['no response at all', undefined, false],
    ['a response with no series', empty(), false],
    ['a response with one series', vector([{ value: '0' }]), true],
  ])('is %s', (_name, response, expected) => {
    expect(hasSeries(response)).toBe(expected);
  });

  it('is true for a series whose value is zero', () => {
    // The whole availability probe rests on this: a healthy node still has a
    // series, carrying 0. Only an absent series means nobody is scraping.
    expect(hasSeries(vector([{ value: '0' }]))).toBe(true);
  });
});

describe('instantValue', () => {
  it('reads the first series', () => {
    expect(instantValue(vector([{ value: '3' }]))).toBe(3);
  });

  it('is zero when the series does not exist', () => {
    expect(instantValue(empty())).toBe(0);
    expect(instantValue(undefined)).toBe(0);
  });

  it('is zero rather than NaN for something unparseable', () => {
    expect(instantValue(vector([{ value: 'NaN' }]))).toBe(0);
  });
});

describe('instantByLabel', () => {
  it('keys values by the label', () => {
    const response = vector([
      { labels: { by: 'demand' }, value: '2' },
      { labels: { by: 'config' }, value: '1' },
    ]);
    expect(instantByLabel(response, 'by')).toEqual({ demand: 2, config: 1 });
  });

  it('sums series sharing a key', () => {
    const response = vector([
      { labels: { by: 'demand' }, value: '2' },
      { labels: { by: 'demand' }, value: '3' },
    ]);
    expect(instantByLabel(response, 'by')).toEqual({ demand: 5 });
  });

  it('ignores a series that does not carry the label', () => {
    expect(instantByLabel(vector([{ value: '9' }]), 'by')).toEqual({});
  });
});

describe('rangeSamples', () => {
  it('converts Prometheus seconds to milliseconds', () => {
    expect(rangeSamples(matrix([[1700000000, '1']]))).toEqual([
      { t: 1700000000000, value: 1 },
    ]);
  });

  it('is empty when there is nothing', () => {
    expect(rangeSamples(undefined)).toEqual([]);
    expect(rangeSamples(empty())).toEqual([]);
  });
});

describe('timespans', () => {
  it('agree with the PromQL durations they are spelled as', () => {
    expect(timespanMillis('24h')).toBe(24 * 60 * 60 * 1000);
    expect(timespanMillis('7d')).toBe(7 * 24 * 60 * 60 * 1000);
    expect(timespanMillis('30d')).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('divide into the sample count to give the step', () => {
    expect(stepMillis('24h')).toBe(timespanMillis('24h') / SAMPLES);
  });
});

describe('dataBeginsAt', () => {
  const step = 1000;
  const span = 100_000;

  it('says nothing when the window is covered', () => {
    const samples = [
      { t: 0, value: 0 },
      { t: span, value: 0 },
    ];
    expect(dataBeginsAt(samples, span, step)).toBeUndefined();
  });

  it('reports where the data starts when it starts late', () => {
    // Retention shorter than the window: this is the case that would otherwise
    // draw a short strip and read as a quiet period.
    const samples = [
      { t: 90_000, value: 0 },
      { t: 100_000, value: 0 },
    ];
    expect(dataBeginsAt(samples, span, step)).toBe(90_000);
  });

  it('tolerates a couple of steps of misalignment at the left edge', () => {
    const samples = [
      { t: 1500, value: 0 },
      { t: span, value: 0 },
    ];
    expect(dataBeginsAt(samples, span, step)).toBeUndefined();
  });

  it('says nothing when there are no samples', () => {
    expect(dataBeginsAt([], span, step)).toBeUndefined();
  });
});

describe('resolution', () => {
  it('says how much time one sample stands for', () => {
    expect(resolution('24h')).toEqual({ value: 12, unit: 'minutes' });
    expect(resolution('7d')).toEqual({ value: 84, unit: 'minutes' });
    // The one worth stating on screen: at 30 days a single failing sample
    // paints six hours of band, which reads as an outage rather than a blip.
    expect(resolution('30d')).toEqual({ value: 6, unit: 'hours' });
  });
});

describe('splitAtGaps', () => {
  const step = 10;

  it('keeps evenly spaced samples in one run', () => {
    const samples = [
      { t: 0, value: 0 },
      { t: 10, value: 0 },
      { t: 20, value: 0 },
    ];
    expect(splitAtGaps(samples, step)).toEqual([samples]);
  });

  it('breaks where a sample is missing', () => {
    const samples = [
      { t: 0, value: 0 },
      { t: 30, value: 0 },
    ];
    expect(splitAtGaps(samples, step)).toEqual([
      [{ t: 0, value: 0 }],
      [{ t: 30, value: 0 }],
    ]);
  });

  it('does not break on ordinary jitter within a step and a half', () => {
    const samples = [
      { t: 0, value: 0 },
      { t: 14, value: 0 },
    ];
    expect(splitAtGaps(samples, step)).toEqual([samples]);
  });

  it('is empty for no samples', () => {
    expect(splitAtGaps([], step)).toEqual([]);
  });
});

describe('toSegments', () => {
  const step = 10;

  it('is empty for no samples', () => {
    expect(toSegments([], step)).toEqual([]);
  });

  it('collapses a run into one segment reaching a step past its last sample', () => {
    const samples = [
      { t: 0, value: 0 },
      { t: 10, value: 0 },
      { t: 20, value: 0 },
    ];
    expect(toSegments(samples, step)).toEqual([
      { from: 0, to: 30, state: 'ok' },
    ]);
  });

  it('splits where the state changes', () => {
    const samples = [
      { t: 0, value: 0 },
      { t: 10, value: 1 },
      { t: 20, value: 0 },
    ];
    expect(toSegments(samples, step)).toEqual([
      { from: 0, to: 10, state: 'ok' },
      { from: 10, to: 20, state: 'failed' },
      { from: 20, to: 30, state: 'ok' },
    ]);
  });

  it('treats any value above zero as failing, so the cluster-wide count works', () => {
    const samples = [
      { t: 0, value: 3 },
      { t: 10, value: 7 },
    ];
    expect(toSegments(samples, step)).toEqual([
      { from: 0, to: 20, state: 'failed' },
    ]);
  });

  // The defect this whole third state exists for. Both sides say the node was
  // failing; nothing says it was failing in between, and the band used to say
  // so anyway — a red bar across the night the cluster was switched off.
  it('does not paint across a gap when both sides agree', () => {
    const samples = [
      { t: 0, value: 1 },
      { t: 100, value: 1 },
    ];
    expect(toSegments(samples, step)).toEqual([
      { from: 0, to: 10, state: 'failed' },
      { from: 10, to: 100, state: 'gap' },
      { from: 100, to: 110, state: 'failed' },
    ]);
  });

  it('names the gap when the two sides disagree, instead of leaving it blank', () => {
    const samples = [
      { t: 0, value: 0 },
      { t: 100, value: 1 },
    ];
    expect(toSegments(samples, step)).toEqual([
      { from: 0, to: 10, state: 'ok' },
      { from: 10, to: 100, state: 'gap' },
      { from: 100, to: 110, state: 'failed' },
    ]);
  });
});

describe('stepPaths', () => {
  const plot = { width: 100, height: 10, peak: 2, step: 50 };

  it('draws nothing when there is nothing to draw', () => {
    expect(stepPaths([], plot)).toEqual([]);
    expect(stepPaths([{ t: 5, value: 1 }], plot)).toEqual([]);
  });

  it('holds each value until the next sample instead of sloping to it', () => {
    const samples = [
      { t: 0, value: 0 },
      { t: 50, value: 2 },
      { t: 100, value: 2 },
    ];
    // The corner at x=50 is what makes this a step: the value was 0 right up
    // to that scrape, and a diagonal would put the change halfway between two
    // scrapes, which is a time nothing happened at.
    expect(stepPaths(samples, plot)).toEqual([
      {
        points: '0.00,10.00 50.00,10.00 50.00,0.00 100.00,0.00',
        from: 0,
        to: 100,
      },
    ]);
  });

  it('emits one point per sample while the value holds', () => {
    const samples = [
      { t: 0, value: 2 },
      { t: 50, value: 2 },
      { t: 100, value: 2 },
    ];
    expect(stepPaths(samples, plot)[0].points).toBe(
      '0.00,0.00 50.00,0.00 100.00,0.00',
    );
  });

  it('draws a series of zeroes flat along the bottom rather than dividing by it', () => {
    const samples = [
      { t: 0, value: 0 },
      { t: 100, value: 0 },
    ];
    // Step widened to match the spacing: two samples a whole window apart are
    // a gap under the default step, which is a different test than this one.
    expect(stepPaths(samples, { ...plot, peak: 0, step: 100 })[0].points).toBe(
      '0.00,10.00 100.00,10.00',
    );
  });

  // A step line holding its value is right until there is nothing to hold it
  // to. One path per run is what stops the line running flat through hours
  // nobody measured, and each carries its own x range so the area under it
  // closes where the data does rather than at the edges of the plot.
  it('breaks into a path per run rather than running through a gap', () => {
    const samples = [
      { t: 0, value: 2 },
      { t: 10, value: 2 },
      { t: 90, value: 1 },
      { t: 100, value: 1 },
    ];
    expect(stepPaths(samples, { ...plot, step: 10 })).toEqual([
      { points: '0.00,0.00 10.00,0.00', from: 0, to: 10 },
      { points: '90.00,5.00 100.00,5.00', from: 90, to: 100 },
    ]);
  });
});

describe('returnedFraction', () => {
  const samples = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ t: i * 1000, value: 0 }));

  it('says nothing when the window came back as full as it was asked for', () => {
    expect(returnedFraction(samples(120), 120)).toBeUndefined();
    expect(returnedFraction(samples(121), 120)).toBeUndefined();
  });

  // A range query answers at a grid of instants and puts a point at one only if
  // a sample exists within Prometheus's five-minute lookback. Measured on the
  // lab, where the cluster is switched off nightly: 22 points of 121 over 24
  // hours, 4 over 7 days, 1 over 30 — so the 30-day band was one sample drawn
  // at full width, and nothing on screen said so.
  it('reports how much of the window arrived when it did not all arrive', () => {
    expect(returnedFraction(samples(1), 120)).toEqual({
      returned: 1,
      requested: 120,
    });
  });

  it('counts an empty answer as an empty answer rather than as no opinion', () => {
    expect(returnedFraction([], 120)).toEqual({ returned: 0, requested: 120 });
  });
});
