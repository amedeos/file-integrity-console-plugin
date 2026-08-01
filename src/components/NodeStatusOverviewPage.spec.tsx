import * as React from 'react';
import { render, screen } from '@testing-library/react';
import NodeStatusOverviewPage from './NodeStatusOverviewPage';
import type { FileIntegrity, FileIntegrityNodeStatus } from '../types';

// Mocks the shim, not the package: which router package supplies Link differs
// by console generation, and the component only ever sees the shim. The href is
// kept, because it is what this file is about.
jest.mock('../lib/router', () => ({
  Link: ({ to, children }: { to: string; children?: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

const mockStatuses = jest.fn<FileIntegrityNodeStatus[], []>();

jest.mock('../hooks/useFileIntegrityData', () => ({
  useFileIntegrities: (): [FileIntegrity[], boolean, unknown] => [
    [{ metadata: { name: 'example-fileintegrity' } }],
    true,
    undefined,
  ],
  useNodeStatuses: (): [FileIntegrityNodeStatus[], boolean, unknown] => [
    mockStatuses(),
    true,
    undefined,
  ],
}));

// Mocked at the hook boundary, like the router: what supplies Prometheus data
// is a console-versioned API the page never sees.
jest.mock('../hooks/useIntegrityMetrics', () => ({
  useMetricsAvailability: () => ({ scraped: false, loaded: true }),
  useFailingNodesHistory: () => ({ samples: [], loaded: true }),
  useReinitCounts: () => ({ counts: {}, total: 0, loaded: true }),
}));

const status = (
  nodeName: string,
  condition: 'Failed' | 'Succeeded',
): FileIntegrityNodeStatus => ({
  metadata: { uid: nodeName },
  nodeName,
  lastResult: { condition },
});

describe('NodeStatusOverviewPage', () => {
  beforeEach(() => {
    mockStatuses.mockReturnValue([
      status('node-failed', 'Failed'),
      status('node-clean', 'Succeeded'),
    ]);
  });

  it('links every node, not only the ones reporting changes', async () => {
    // The report page's history panel is worth reading precisely for a node
    // that is currently fine, so withholding the link from it — which is what
    // the first version did — hides the answer behind the question.
    render(<NodeStatusOverviewPage />);

    for (const node of ['node-failed', 'node-clean']) {
      expect(await screen.findByRole('link', { name: node })).toHaveAttribute(
        'href',
        `/file-integrity/example-fileintegrity/nodes/${node}`,
      );
    }
  });

  it('leaves a node without an owning FileIntegrity as plain text', async () => {
    // Not a policy about failures: the route needs a FileIntegrity name, and
    // there is nothing to put in it.
    // An owner reference naming a FileIntegrity that is not in the list is
    // what defeats the single-FileIntegrity fallback.
    mockStatuses.mockReturnValue([
      {
        metadata: {
          uid: 'orphan',
          ownerReferences: [{ kind: 'FileIntegrity', name: 'gone', uid: 'x' }],
        },
        nodeName: 'orphan',
        lastResult: { condition: 'Succeeded' },
      } as FileIntegrityNodeStatus,
    ]);

    render(<NodeStatusOverviewPage />);

    expect(await screen.findByText('orphan')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'orphan' })).toBeNull();
  });
});
