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
import { FileIntegrity, FileIntegrityNodeStatus } from '../types';
import { ResultConfigMap } from '../lib/decode';

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

type ResultState = {
  configMap?: ResultConfigMap;
  loaded: boolean;
  error?: unknown;
};

/**
 * Fetches a single result ConfigMap on demand.
 *
 * Deliberately a one-shot GET rather than a watch: on a large cluster there is
 * one of these per failing node and each can approach the 1MB object limit, so
 * watching them all would be wasteful. Reports only change when a new scan
 * fails, and the user can reload.
 */
export const useResultConfigMap = (name?: string): ResultState => {
  const [state, setState] = React.useState<ResultState>({ loaded: false });

  React.useEffect(() => {
    let cancelled = false;

    if (!name) {
      setState({ loaded: true });
      return undefined;
    }

    setState({ loaded: false });
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
      .catch((error) => {
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
