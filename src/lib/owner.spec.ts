import { ownerOf, statusOf } from './owner';
import type { FileIntegrity, FileIntegrityNodeStatus } from '../types';

const masters: FileIntegrity = { metadata: { name: 'masters' } };
const workers: FileIntegrity = { metadata: { name: 'workers' } };

const status = (
  owner: string | undefined,
  nodeName: string,
  condition: 'Succeeded' | 'Failed',
): FileIntegrityNodeStatus => ({
  metadata: {
    name: `${owner ?? 'orphan'}-${nodeName}`,
    ownerReferences: owner
      ? [{ kind: 'FileIntegrity', name: owner, apiVersion: '', uid: '' }]
      : undefined,
  },
  nodeName,
  lastResult: { condition },
});

describe('ownerOf', () => {
  it('resolves the owner through the ownerReference', () => {
    expect(
      ownerOf(status('workers', 'node-1', 'Failed'), [masters, workers]),
    ).toBe(workers);
  });

  it('falls back to the only FileIntegrity when the reference is missing', () => {
    expect(ownerOf(status(undefined, 'node-1', 'Failed'), [masters])).toBe(
      masters,
    );
  });

  it('admits it does not know when several could be the owner', () => {
    // Guessing would attribute the status to whichever came first, which is an
    // answer with nothing behind it.
    expect(
      ownerOf(status(undefined, 'node-1', 'Failed'), [masters, workers]),
    ).toBeUndefined();
  });

  it('returns undefined when the named owner is not among the resources', () => {
    expect(
      ownerOf(status('deleted', 'node-1', 'Failed'), [masters, workers]),
    ).toBeUndefined();
  });
});

describe('statusOf', () => {
  // Two FileIntegrity resources whose selectors overlap: one node, two
  // statuses, and they disagree about it. This is the case the page used to get
  // wrong, and the order is deliberate — the wrong answer is the one the list
  // holds first.
  const overlapping = [
    status('masters', 'node-1', 'Failed'),
    status('workers', 'node-1', 'Succeeded'),
  ];
  const fis = [masters, workers];

  it('picks the status belonging to the FileIntegrity in the route', () => {
    expect(statusOf(overlapping, fis, 'workers', 'node-1')?.lastResult).toEqual(
      {
        condition: 'Succeeded',
      },
    );
    expect(statusOf(overlapping, fis, 'masters', 'node-1')?.lastResult).toEqual(
      {
        condition: 'Failed',
      },
    );
  });

  it('finds nothing when that FileIntegrity does not cover the node', () => {
    expect(statusOf(overlapping, fis, 'workers', 'node-2')).toBeUndefined();
  });

  it('still works for the ordinary single-resource cluster', () => {
    const single = [status(undefined, 'node-1', 'Failed')];
    expect(statusOf(single, [masters], 'masters', 'node-1')).toBe(single[0]);
  });
});
