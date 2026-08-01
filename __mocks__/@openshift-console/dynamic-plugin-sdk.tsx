/*
 * A majority of the OpenShift Console's dynamic plugin SDK components and API
 * implementations are only available at runtime as they are provided using
 * module federation.
 *
 * As a result, no implementations of these components and APIs are available
 * when running tests in your plugin.
 *
 * To workaround this, you may add minimal stub implementations of components
 * and APIs you use in your plugin here to allow your tests to run.
 */
import type * as SDK from '@openshift-console/dynamic-plugin-sdk';

export const ListPageHeader: typeof SDK.ListPageHeader = ({ title }) => <h1>{title}</h1>;

export const DocumentTitle: typeof SDK.DocumentTitle = () => null;

export const Timestamp: typeof SDK.Timestamp = ({ timestamp }) => (
  <span>{String(timestamp)}</span>
);

// The 4.22 names. Older SDKs call these k8sGetResource / k8sPatchResource;
// src/lib/k8s.ts is where that difference is absorbed.
export const k8sPatch = jest.fn(() => Promise.resolve({}));

export const k8sGet = jest.fn(() => Promise.resolve({}));

export const useK8sWatchResource = jest.fn(() => [[], true, undefined]);

// The console resolves these at runtime too. The enum has to be a real value
// because the hooks below pass its members, and the poll defaults to "loaded,
// nothing there" — which is what a cluster with no monitoring answers, and so
// the state a test gets unless it says otherwise.
export const PrometheusEndpoint = {
  LABEL: 'api/v1/label',
  QUERY: 'api/v1/query',
  QUERY_RANGE: 'api/v1/query_range',
  RULES: 'api/v1/rules',
  TARGETS: 'api/v1/targets',
} as unknown as typeof SDK.PrometheusEndpoint;

export const usePrometheusPoll = jest.fn(() => [undefined, true, undefined]);
