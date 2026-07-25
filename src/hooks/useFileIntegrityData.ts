import * as React from 'react';
import {
  k8sGet,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import { FIO_NAMESPACE } from '../constants';
import {
  ConfigMapModel,
  FileIntegrityModel,
  FileIntegrityNodeStatusModel,
} from '../models';
import type { FileIntegrity, FileIntegrityNodeStatus } from '../types';
import type { ResultConfigMap } from '../lib/decode';

const fiResource = {
  groupVersionKind: {
    group: FileIntegrityModel.apiGroup,
    version: FileIntegrityModel.apiVersion,
    kind: FileIntegrityModel.kind,
  },
  namespace: FIO_NAMESPACE,
  isList: true,
};

const nodeStatusResource = {
  groupVersionKind: {
    group: FileIntegrityNodeStatusModel.apiGroup,
    version: FileIntegrityNodeStatusModel.apiVersion,
    kind: FileIntegrityNodeStatusModel.kind,
  },
  namespace: FIO_NAMESPACE,
  isList: true,
};

export const useFileIntegrities = (): [FileIntegrity[], boolean, unknown] =>
  useK8sWatchResource<FileIntegrity[]>(fiResource);

export const useNodeStatuses = (): [
  FileIntegrityNodeStatus[],
  boolean,
  unknown,
] => useK8sWatchResource<FileIntegrityNodeStatus[]>(nodeStatusResource);

interface ResultState {
  configMap?: ResultConfigMap;
  loaded: boolean;
  error?: unknown;
}

/**
 * Fetches a single result ConfigMap on demand.
 *
 * Deliberately a one-shot GET rather than a watch: on a large cluster there is
 * one of these per failing node and each can approach the 1MB object limit, so
 * watching them all would be wasteful. Reports only change when a new scan
 * fails, and the user can reload.
 */
export const useResultConfigMap = (name?: string): ResultState => {
  // `loaded` starts true when there is nothing to fetch, so a node with no
  // result ConfigMap renders its "no report" state instead of a spinner that
  // never resolves.
  const [state, setState] = React.useState<ResultState>({ loaded: !name });
  const [fetchedFor, setFetchedFor] = React.useState(name);

  // Cleared during render rather than inside the effect: effects run after the
  // browser has painted, so resetting there shows one frame of the previous
  // node's report underneath the new node's heading.
  if (name !== fetchedFor) {
    setFetchedFor(name);
    setState({ loaded: !name });
  }

  React.useEffect(() => {
    if (!name) {
      return undefined;
    }
    let cancelled = false;

    k8sGet<ResultConfigMap>({
      model: ConfigMapModel,
      name,
      ns: FIO_NAMESPACE,
    })
      .then((configMap) => {
        if (!cancelled) {
          setState({ configMap, loaded: true });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ loaded: true, error });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [name]);

  return state;
};
