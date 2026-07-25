import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReinitBulkActions } from './ReinitActions';
import type { FileIntegrity } from '../types';

const fis: FileIntegrity[] = [{ metadata: { name: 'example-fileintegrity' } }];

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
});
