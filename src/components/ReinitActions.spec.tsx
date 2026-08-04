import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReinitBulkActions } from './ReinitActions';
import { k8sPatch } from '../lib/k8s';
import type { FileIntegrity } from '../types';

const fis: FileIntegrity[] = [{ metadata: { name: 'example-fileintegrity' } }];

// Named through the shim, not through the SDK package: which package supplies
// k8sPatch is the thing src/lib/k8s.ts exists to hide, and a test that reaches
// past it would have to be edited on every release branch.
const patch = k8sPatch as unknown as jest.Mock;

beforeEach(() => {
  patch.mockReset();
  patch.mockResolvedValue({});
});

describe('ReinitBulkActions', () => {
  it('renders nothing when no FileIntegrity exists', () => {
    const { container } = render(<ReinitBulkActions fileIntegrities={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  // Where the menu lands on screen is not assertable here: jsdom measures every
  // element as zero-sized, so the popper's placement is meaningless. This only
  // pins the interaction — that the toggle opens the menu and both actions are
  // reachable by their full label.
  it('opens the menu with both actions', async () => {
    const user = userEvent.setup();
    render(<ReinitBulkActions fileIntegrities={fis} />);

    await user.click(screen.getByRole('button', { name: 'Actions' }));

    expect(
      screen.getByRole('menuitem', {
        name: 'Re-initialize baseline on nodes with changes',
      }),
    ).toBeVisible();
    expect(
      screen.getByRole('menuitem', {
        name: 'Re-initialize baseline on all nodes',
      }),
    ).toBeVisible();
  });

  it('asks for confirmation before re-initialising every node', async () => {
    const user = userEvent.setup();
    render(<ReinitBulkActions fileIntegrities={fis} />);

    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(
      screen.getByRole('menuitem', {
        name: 'Re-initialize baseline on all nodes',
      }),
    );

    // The warning about losing the current findings is the point of the modal,
    // so assert on it rather than on the dialog merely existing.
    expect(
      screen.getByText(/stops being reported/, { exact: false }),
    ).toBeVisible();
  });

  // With two FileIntegrity resources one request can fail while the other
  // succeeds. Promise.all abandons the moment the first rejects, so the modal
  // used to report a total failure — and the reader, told nothing had happened,
  // would press the button again.
  it('says how many resources were updated when only some fail', async () => {
    const user = userEvent.setup();
    patch
      .mockRejectedValueOnce(new Error('forbidden: masters'))
      .mockResolvedValueOnce({});

    render(
      <ReinitBulkActions
        fileIntegrities={[
          { metadata: { name: 'masters' } },
          { metadata: { name: 'workers' } },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(
      screen.getByRole('menuitem', {
        name: 'Re-initialize baseline on all nodes',
      }),
    );
    await user.click(
      screen.getByRole('button', { name: 'Re-initialize baseline' }),
    );

    // Both were attempted — the failure of the first must not cancel the
    // second, which is the whole difference between all and allSettled.
    expect(patch).toHaveBeenCalledTimes(2);
    expect(
      await screen.findByText(
        /1 of 2 FileIntegrity resources could not be updated; the others were\. First failure: forbidden: masters/,
      ),
    ).toBeVisible();
    // The modal stays open: closing it would file a partial failure as done.
    expect(
      screen.getByRole('button', { name: 'Re-initialize baseline' }),
    ).toBeVisible();
  });

  it('closes the modal when every resource is updated', async () => {
    const user = userEvent.setup();
    render(
      <ReinitBulkActions
        fileIntegrities={[
          { metadata: { name: 'masters' } },
          { metadata: { name: 'workers' } },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(
      screen.getByRole('menuitem', {
        name: 'Re-initialize baseline on all nodes',
      }),
    );
    await user.click(
      screen.getByRole('button', { name: 'Re-initialize baseline' }),
    );

    expect(patch).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByText(/stops being reported/, { exact: false }),
    ).not.toBeInTheDocument();
  });
});
