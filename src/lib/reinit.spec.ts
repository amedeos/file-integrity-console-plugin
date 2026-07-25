import { ANNOTATIONS } from '../constants';
import { FileIntegrity } from '../types';
import {
  addNodeToReinit,
  annotationPatchPath,
  isNodeHeldOff,
  isNodeReinitializing,
  setAnnotationPatch,
} from './reinit';

const fi = (annotations?: Record<string, string>): FileIntegrity => ({
  apiVersion: 'fileintegrity.openshift.io/v1alpha1',
  kind: 'FileIntegrity',
  metadata: { name: 'example', namespace: 'openshift-file-integrity', annotations },
});

describe('addNodeToReinit', () => {
  it('sets the node when no request is pending', () => {
    expect(addNodeToReinit(undefined, 'worker-0')).toBe('worker-0');
  });

  it('appends to an existing list', () => {
    expect(addNodeToReinit('worker-0', 'worker-1')).toBe('worker-0,worker-1');
  });

  it('is a no-op when the node is already listed', () => {
    expect(addNodeToReinit('worker-0,worker-1', 'worker-1')).toBeUndefined();
  });

  it('never narrows a cluster-wide request', () => {
    // The operator reads an empty annotation as "every node", so writing a
    // single node name over it would cancel the wider re-init already running.
    expect(addNodeToReinit('', 'worker-0')).toBeUndefined();
    expect(addNodeToReinit('   ', 'worker-0')).toBeUndefined();
  });

  it('tolerates padded lists', () => {
    expect(addNodeToReinit('worker-0, worker-1', 'worker-2')).toBe(
      'worker-0,worker-1,worker-2',
    );
  });
});

describe('isNodeReinitializing', () => {
  it('is false without the annotation', () => {
    expect(isNodeReinitializing(fi(), 'worker-0')).toBe(false);
    expect(isNodeReinitializing(undefined, 'worker-0')).toBe(false);
  });

  it('is true for every node when the annotation is empty', () => {
    expect(isNodeReinitializing(fi({ [ANNOTATIONS.reinit]: '' }), 'any')).toBe(
      true,
    );
  });

  it('matches a listed node only', () => {
    const r = fi({ [ANNOTATIONS.reinit]: 'worker-0,worker-2' });
    expect(isNodeReinitializing(r, 'worker-0')).toBe(true);
    expect(isNodeReinitializing(r, 'worker-1')).toBe(false);
  });
});

describe('isNodeHeldOff', () => {
  it('reads the holdoff annotation', () => {
    const r = fi({ [ANNOTATIONS.holdoff]: 'worker-3' });
    expect(isNodeHeldOff(r, 'worker-3')).toBe(true);
    expect(isNodeHeldOff(r, 'worker-4')).toBe(false);
  });
});

describe('annotationPatchPath', () => {
  it('escapes slashes per RFC 6901', () => {
    expect(annotationPatchPath(ANNOTATIONS.reinit)).toBe(
      '/metadata/annotations/file-integrity.openshift.io~1re-init',
    );
  });
});

describe('setAnnotationPatch', () => {
  it('creates the annotations map when the object has none', () => {
    // `add` into a missing parent object is an error, so the whole map has to
    // be created in one operation.
    expect(setAnnotationPatch(fi(), ANNOTATIONS.reinit, '')).toEqual([
      { op: 'add', path: '/metadata/annotations', value: { [ANNOTATIONS.reinit]: '' } },
    ]);
  });

  it('adds a single key when annotations already exist', () => {
    const patch = setAnnotationPatch(
      fi({ other: 'x' }),
      ANNOTATIONS.reinit,
      'worker-0',
    );
    expect(patch).toEqual([
      {
        op: 'add',
        path: '/metadata/annotations/file-integrity.openshift.io~1re-init',
        value: 'worker-0',
      },
    ]);
  });
});
