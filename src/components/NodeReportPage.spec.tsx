import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NodeReportPage from './NodeReportPage';
import type { FileIntegrity, FileIntegrityNodeStatus } from '../types';
import type { ResultConfigMap } from '../lib/decode';

// Mocks the shim, not the package: which router package supplies these differs
// by console generation, and the component only ever sees the shim.
jest.mock('../lib/router', () => ({
  useParams: () => ({ fiName: 'example-fileintegrity', nodeName: 'node-0' }),
  // Written out rather than as `PropsWithChildren`, which only gained a default
  // type argument in @types/react 18: bare it fails to compile on the React 17
  // release branches, and spelled `<unknown>` it trips
  // `no-unnecessary-type-arguments` here. This form satisfies both.
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));

const mockConfigMap = jest.fn<ResultConfigMap | undefined, []>();

// The whole tuple, so a test can say "refused, and therefore never loaded" —
// which is what a watch the API server rejects looks like, and what this page
// used to discard entirely.
const mockNodeStatuses = jest.fn<
  [FileIntegrityNodeStatus[], boolean, unknown],
  []
>();

jest.mock('../hooks/useFileIntegrityData', () => ({
  useFileIntegrities: (): [FileIntegrity[], boolean, unknown] => [
    [{ metadata: { name: 'example-fileintegrity' } }],
    true,
    undefined,
  ],
  useNodeStatuses: (): [FileIntegrityNodeStatus[], boolean, unknown] =>
    mockNodeStatuses(),
  useResultConfigMap: () => ({ configMap: mockConfigMap(), loaded: true }),
}));

// Mocked at the hook boundary for the same reason as the router above: what
// supplies Prometheus data is a console-versioned API the page never sees.
const mockAvailability = jest.fn<
  { scraped: boolean; loaded: boolean; error?: unknown },
  []
>(() => ({ scraped: true, loaded: true }));

const mockNodeHistory = jest.fn<
  {
    samples: never[];
    segments: never[];
    beginsAt?: number;
    failures: number;
    loaded: boolean;
    error?: unknown;
  },
  []
>(() => ({
  samples: [],
  segments: [],
  failures: 0,
  loaded: true,
}));

jest.mock('../hooks/useIntegrityMetrics', () => ({
  useMetricsAvailability: () => mockAvailability(),
  useNodeFailureHistory: () => mockNodeHistory(),
}));

const configMapWith = (integritylog: string): ResultConfigMap => ({
  metadata: { name: 'aide-example-node-0-failed', annotations: {} },
  data: { integritylog },
});

const PARSEABLE_REPORT = [
  'Start timestamp: 2026-07-25 15:11:08 +0000 (AIDE 0.16)',
  'AIDE found differences between database and filesystem!!',
  '',
  'Summary:',
  '  Total number of entries:\t40932',
  '  Added entries:\t\t1',
  '  Removed entries:\t\t0',
  '  Changed entries:\t\t0',
  '',
  '---------------------------------------------------',
  'Added entries:',
  '---------------------------------------------------',
  '',
  'f++++++++++++++++: /hostroot/etc/fio-demo-added.conf',
  '',
].join('\n');

// What the operator writes instead of the report when it exceeds the ConfigMap
// size limit (cmd/manager/logcollector_util.go).
const TRUNCATED_REPORT =
  'The AIDE log is too large for a configMap, fetch it from ' +
  '/etc/kubernetes/aide.log on node node-0';

const NODE_STATUSES: [FileIntegrityNodeStatus[], boolean, unknown] = [
  [
    {
      nodeName: 'node-0',
      lastResult: {
        condition: 'Failed',
        resultConfigMapName: 'aide-example-node-0-failed',
      },
    },
  ],
  true,
  undefined,
];

const rawToggle = () => screen.getByRole('button', { name: /raw AIDE report/ });

describe('NodeReportPage raw report section', () => {
  beforeEach(() => {
    mockConfigMap.mockReturnValue(configMapWith(PARSEABLE_REPORT));
    mockNodeStatuses.mockReturnValue(NODE_STATUSES);
  });

  it('stops waiting once the watch has been refused', () => {
    // This page discarded both watch errors outright, so a user the API server
    // refuses got a spinner that never stopped and no word about why. The
    // overview at least printed the message beside it.
    mockNodeStatuses.mockReturnValue([
      [],
      false,
      new Error('fileintegritynodestatuses is forbidden'),
    ]);

    render(<NodeReportPage />);

    expect(
      screen.getByText('Could not load File Integrity data'),
    ).toBeVisible();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('opens and closes the raw report when the toggle is clicked', async () => {
    const user = userEvent.setup();
    render(<NodeReportPage />);

    // Collapsed to begin with: with a report that parsed cleanly, the table is
    // the useful view. PatternFly keeps the content mounted and hides it, so
    // visibility is what has to be asserted, not presence.
    await waitFor(() => {
      expect(rawToggle()).toHaveAttribute('aria-expanded', 'false');
    });
    expect(screen.getByText(/Start timestamp/)).not.toBeVisible();

    await user.click(rawToggle());
    expect(rawToggle()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Start timestamp/)).toBeVisible();

    await user.click(rawToggle());
    expect(rawToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText(/Start timestamp/)).not.toBeVisible();
  });

  it('starts expanded when the operator truncated the report', async () => {
    mockConfigMap.mockReturnValue(configMapWith(TRUNCATED_REPORT));
    render(<NodeReportPage />);

    await waitFor(() => {
      expect(rawToggle()).toHaveAttribute('aria-expanded', 'true');
    });
    expect(screen.getByText(/too large for a configMap/)).toBeVisible();
  });

  it('lets the user close a report that opened itself', async () => {
    const user = userEvent.setup();
    mockConfigMap.mockReturnValue(configMapWith(TRUNCATED_REPORT));
    render(<NodeReportPage />);

    await waitFor(() => {
      expect(rawToggle()).toHaveAttribute('aria-expanded', 'true');
    });
    await user.click(rawToggle());
    expect(rawToggle()).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('NodeReportPage history card', () => {
  beforeEach(() => {
    mockConfigMap.mockReturnValue(configMapWith(PARSEABLE_REPORT));
    mockNodeStatuses.mockReturnValue(NODE_STATUSES);
    mockAvailability.mockReturnValue({ scraped: true, loaded: true });
    mockNodeHistory.mockReturnValue({
      samples: [],
      segments: [],
      failures: 0,
      loaded: true,
    });
  });

  // Awaited rather than asserted synchronously: the report underneath decodes
  // and parses in an effect, and a synchronous assertion returns before that
  // settles, which React reports as an update outside act().
  it('is there whatever the node is currently doing', async () => {
    render(<NodeReportPage />);

    expect(await screen.findByText('Integrity over time')).toBeVisible();
  });

  it('offers the three windows', async () => {
    render(<NodeReportPage />);

    for (const window of ['24 hours', '7 days', '30 days']) {
      expect(await screen.findByRole('button', { name: window })).toBeVisible();
    }
  });

  it('explains itself when nothing is collecting the metrics', async () => {
    // The state a cluster is in before anyone labels the operator's namespace,
    // which is to say the state most people meet first.
    mockAvailability.mockReturnValue({ scraped: false, loaded: true });

    render(<NodeReportPage />);

    expect(
      await screen.findByText('No history is being recorded'),
    ).toBeVisible();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('reports a failed query as a warning rather than as no history', async () => {
    mockAvailability.mockReturnValue({
      scraped: true,
      loaded: true,
      error: new Error('forbidden'),
    });

    render(<NodeReportPage />);

    expect(await screen.findByText('Could not read the history')).toBeVisible();
    expect(screen.queryByText('No history is being recorded')).toBeNull();
  });
});
