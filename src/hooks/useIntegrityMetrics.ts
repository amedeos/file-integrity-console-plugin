import * as React from 'react';
import { PrometheusEndpoint, usePrometheusPoll } from '../lib/k8s';
import { FIO_NAMESPACE, REINIT_CAUSES } from '../constants';
import type { ReinitCause } from '../constants';
import {
  SAMPLES,
  dataBeginsAt,
  hasSeries,
  instantByLabel,
  instantValue,
  queries,
  rangeSamples,
  returnedFraction,
  stepMillis,
  timespanMillis,
  toSegments,
} from '../lib/series';
import type { Sample, Segment, Timespan } from '../lib/series';

/**
 * History, read from the metrics the File Integrity Operator already exposes.
 *
 * Every query goes through the console's own Prometheus proxy and therefore
 * carries the browsing user's identity. The plugin's backend is not involved
 * and gains no permission: the request-serving path still has no authority of
 * its own, and this feature did not need it to acquire any.
 *
 * The hooks return named objects rather than the SDK's tuple because they
 * reshape what they receive; `useFileIntegrities` next door stays a tuple
 * precisely because it does not.
 */

/**
 * Passing a namespace makes the console route to its *tenancy* proxy, which
 * confines the query to that namespace and asks the API server whether this
 * user may read there. Leaving it undefined uses the cluster-wide proxy, which
 * needs `cluster-monitoring-view` — a much larger thing to ask of someone who
 * only wants to look at a node report.
 *
 * So it is set, and it is one line to unset if a cluster ever shows that the
 * tenancy proxy does not serve platform-monitoring series. That is a question
 * for a cluster, not for a code review.
 */
const QUERY_NAMESPACE: string | undefined = FIO_NAMESPACE;

/**
 * Whether anything is collecting the operator's metrics.
 *
 * This is deliberately its own query rather than an inference from the panels'
 * own emptiness. A per-node range comes back empty both when nobody is
 * scraping and when that particular node simply has no series, and those want
 * different words on screen — one is the cluster's configuration, the other is
 * a node the operator has not reached yet.
 */
export interface Availability {
  scraped: boolean;
  loaded: boolean;
  error?: unknown;
}

export const useMetricsAvailability = (): Availability => {
  const [response, loaded, error] = usePrometheusPoll({
    endpoint: PrometheusEndpoint.QUERY,
    query: queries.scraped(),
    namespace: QUERY_NAMESPACE,
  });

  return { scraped: hasSeries(response), loaded, error };
};

export interface History {
  samples: Sample[];
  segments: Segment[];
  /** Set when the data starts later than the window asked for. */
  beginsAt?: number;
  /** Set when fewer points came back than the window asked for. */
  sparse?: { returned: number; requested: number };
  loaded: boolean;
  error?: unknown;
}

const useHistory = (query: string, timespan: Timespan): History => {
  // An empty query is how the SDK is told not to poll at all, which is what a
  // page with no node name yet should do.
  const [response, loaded, error] = usePrometheusPoll({
    endpoint: PrometheusEndpoint.QUERY_RANGE,
    query,
    namespace: QUERY_NAMESPACE,
    timespan: timespanMillis(timespan),
    samples: SAMPLES,
  });

  return React.useMemo(() => {
    const step = stepMillis(timespan);
    const samples = rangeSamples(response);
    return {
      samples,
      segments: toSegments(samples, step),
      beginsAt: dataBeginsAt(samples, timespanMillis(timespan), step),
      sparse: returnedFraction(samples),
      loaded,
      error,
    };
  }, [response, timespan, loaded, error]);
};

export interface NodeHistory extends History {
  /** Times this node entered the failed state within the window. */
  failures: number;
}

export const useNodeFailureHistory = (
  node: string,
  timespan: Timespan,
): NodeHistory => {
  const history = useHistory(node ? queries.nodeFailed(node) : '', timespan);

  const [countResponse, countLoaded, countError] = usePrometheusPoll({
    endpoint: PrometheusEndpoint.QUERY,
    query: node ? queries.nodeFailures(node, timespan) : '',
    namespace: QUERY_NAMESPACE,
  });

  return {
    ...history,
    failures: instantValue(countResponse),
    loaded: history.loaded && countLoaded,
    error: history.error ?? countError,
  };
};

/** How many nodes were failing, over time. */
export const useFailingNodesHistory = (timespan: Timespan): History =>
  useHistory(queries.failingNodes(), timespan);

export interface ReinitCounts {
  counts: Record<ReinitCause, number>;
  total: number;
  loaded: boolean;
  error?: unknown;
}

/**
 * Re-initialisations in the window, by what caused them.
 *
 * Cluster-wide, because the counter carries no `node` label — checked on a
 * cluster, and the reason this belongs on the overview rather than on a node's
 * page.
 *
 * A counter nobody has incremented does not exist, so an empty response here
 * means none happened. Reporting that as missing data would tell a healthy,
 * correctly configured cluster that its monitoring is broken.
 */
export const useReinitCounts = (timespan: Timespan): ReinitCounts => {
  const [response, loaded, error] = usePrometheusPoll({
    endpoint: PrometheusEndpoint.QUERY,
    query: queries.reinits(timespan),
    namespace: QUERY_NAMESPACE,
  });

  return React.useMemo(() => {
    const byCause = instantByLabel(response, 'by');
    const counts = REINIT_CAUSES.reduce(
      (acc, cause) => ({ ...acc, [cause]: byCause[cause] ?? 0 }),
      {} as Record<ReinitCause, number>,
    );
    return {
      counts,
      total: Object.values(counts).reduce((sum, n) => sum + n, 0),
      loaded,
      error,
    };
  }, [response, loaded, error]);
};
