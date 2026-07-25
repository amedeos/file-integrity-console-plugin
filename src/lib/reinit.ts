import { ANNOTATIONS } from '../constants';
import type { FileIntegrity } from '../types';

/**
 * Builds the annotation value that asks the operator to rebuild the AIDE
 * baseline for a single node.
 *
 * The operator reads `file-integrity.openshift.io/re-init` as a comma separated
 * node list, and treats the annotation being present but empty as "every node"
 * (pkg/common/util.go). That makes the empty string a wider request than any
 * list, so once it is set adding a node would silently *narrow* the request —
 * we return the value unchanged instead.
 *
 * Returns `undefined` when nothing needs to change.
 */
export const addNodeToReinit = (
  current: string | undefined,
  node: string,
): string | undefined => {
  if (current === undefined) {
    return node;
  }
  if (current.trim() === '') {
    // Already re-initialising every node, which includes this one.
    return undefined;
  }
  const nodes = current
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  if (nodes.includes(node)) {
    return undefined;
  }
  return [...nodes, node].join(',');
};

/** True when the operator is currently re-initialising this node's baseline. */
export const isNodeReinitializing = (
  fi: FileIntegrity | undefined,
  node: string,
): boolean => {
  const value = fi?.metadata?.annotations?.[ANNOTATIONS.reinit];
  if (value === undefined) {
    return false;
  }
  if (value.trim() === '') {
    return true;
  }
  return value
    .split(',')
    .map((n) => n.trim())
    .includes(node);
};

/** True when the operator has paused scanning on this node. */
export const isNodeHeldOff = (
  fi: FileIntegrity | undefined,
  node: string,
): boolean => {
  const value = fi?.metadata?.annotations?.[ANNOTATIONS.holdoff];
  if (value === undefined) {
    return false;
  }
  if (value.trim() === '') {
    return true;
  }
  return value
    .split(',')
    .map((n) => n.trim())
    .includes(node);
};

/** JSON Patch path for an annotation key (RFC 6901 escaping). */
export const annotationPatchPath = (key: string): string =>
  `/metadata/annotations/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;

export interface JsonPatch {
  op: 'add' | 'replace' | 'remove';
  path: string;
  value?: string | Record<string, string>;
}

/**
 * Produces the JSON Patch that sets an annotation, creating the annotations
 * map first when the object has none (an `add` into a missing parent object
 * fails otherwise).
 */
export const setAnnotationPatch = (
  fi: FileIntegrity,
  key: string,
  value: string,
): JsonPatch[] => {
  if (!fi.metadata?.annotations) {
    return [
      { op: 'add', path: '/metadata/annotations', value: { [key]: value } },
    ];
  }
  return [{ op: 'add', path: annotationPatchPath(key), value }];
};
