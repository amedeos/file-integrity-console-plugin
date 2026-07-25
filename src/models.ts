import { K8sModel } from '@openshift-console/dynamic-plugin-sdk';

export const FileIntegrityModel: K8sModel = {
  apiGroup: 'fileintegrity.openshift.io',
  apiVersion: 'v1alpha1',
  kind: 'FileIntegrity',
  plural: 'fileintegrities',
  label: 'FileIntegrity',
  labelPlural: 'FileIntegrities',
  abbr: 'FI',
  namespaced: true,
  crd: true,
  id: 'fileintegrity',
};

export const FileIntegrityNodeStatusModel: K8sModel = {
  apiGroup: 'fileintegrity.openshift.io',
  apiVersion: 'v1alpha1',
  kind: 'FileIntegrityNodeStatus',
  plural: 'fileintegritynodestatuses',
  label: 'FileIntegrityNodeStatus',
  labelPlural: 'FileIntegrityNodeStatuses',
  abbr: 'FINS',
  namespaced: true,
  crd: true,
  id: 'fileintegritynodestatus',
};

export const ConfigMapModel: K8sModel = {
  apiVersion: 'v1',
  kind: 'ConfigMap',
  plural: 'configmaps',
  label: 'ConfigMap',
  labelPlural: 'ConfigMaps',
  abbr: 'CM',
  namespaced: true,
  id: 'configmap',
};
