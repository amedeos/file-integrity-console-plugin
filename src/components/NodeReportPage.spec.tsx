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

jest.mock('../hooks/useFileIntegrityData', () => ({
  useFileIntegrities: (): [FileIntegrity[], boolean, unknown] => [
    [{ metadata: { name: 'example-fileintegrity' } }],
    true,
    undefined,
  ],
  useNodeStatuses: (): [FileIntegrityNodeStatus[], boolean, unknown] => [
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
  ],
  useResultConfigMap: () => ({ configMap: mockConfigMap(), loaded: true }),
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

const rawToggle = () => screen.getByRole('button', { name: /raw AIDE report/ });

describe('NodeReportPage raw report section', () => {
  beforeEach(() => {
    mockConfigMap.mockReturnValue(configMapWith(PARSEABLE_REPORT));
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
