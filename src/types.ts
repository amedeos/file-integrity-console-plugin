import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

/** pkg/apis/fileintegrity/v1alpha1: FileIntegrityNodeCondition */
export type NodeCondition = 'Succeeded' | 'Failed' | 'Errored';

/** pkg/apis/fileintegrity/v1alpha1: FileIntegrityStatusPhase */
export type FileIntegrityPhase =
  | 'Initializing'
  | 'Active'
  | 'Pending'
  | 'Error';

/** pkg/apis/fileintegrity/v1alpha1: FileIntegrityScanResult */
export type ScanResult = {
  lastProbeTime?: string;
  condition?: NodeCondition;
  resultConfigMapName?: string;
  resultConfigMapNamespace?: string;
  errorMsg?: string;
  filesAdded?: number;
  filesChanged?: number;
  filesRemoved?: number;
};

/**
 * Note the unusual shape: nodeName/results/lastResult live at the *top level*
 * of the object, not under .status.
 */
export type FileIntegrityNodeStatus = K8sResourceCommon & {
  nodeName?: string;
  results?: ScanResult[];
  lastResult?: ScanResult;
};

export type FileIntegrity = K8sResourceCommon & {
  spec?: {
    nodeSelector?: Record<string, string>;
    config?: {
      name?: string;
      namespace?: string;
      key?: string;
      gracePeriod?: number;
      maxBackups?: number;
      initialDelay?: number;
    };
    debug?: boolean;
  };
  status?: {
    phase?: FileIntegrityPhase;
  };
};

/** A single file mentioned by an AIDE report. */
export type AideEntryKind = 'added' | 'changed' | 'removed';

export type AideAttrChange = {
  /** e.g. "Size", "Mtime", "SHA512", "Perm" */
  name: string;
  /** Value recorded in the AIDE database (absent for added files). */
  old?: string;
  /** Value observed on disk now (absent for removed files). */
  new?: string;
};

export type AideEntry = {
  path: string;
  kind: AideEntryKind;
  /** AIDE's single-letter type marker, e.g. "f" file, "d" directory, "l" link. */
  fileType?: string;
  /** AIDE's terse change string, e.g. "f   ...    .C... ." */
  changeFlags?: string;
  attrs: AideAttrChange[];
};

export type AideSummary = {
  added: number;
  changed: number;
  removed: number;
  totalEntries?: number;
};

export type AideReport = {
  summary: AideSummary;
  entries: AideEntry[];
  /** AIDE version string, when the report header carries one. */
  aideVersion?: string;
  /** Report start time as printed by AIDE, when present. */
  startTime?: string;
  /**
   * True when the operator replaced the report with the "too large for a
   * configMap" sentence. `entries` is then empty and only `raw` is meaningful.
   */
  truncated: boolean;
  /**
   * True when we could not make sense of the text at all. Callers must fall
   * back to rendering `raw`.
   */
  parseFailed: boolean;
  raw: string;
};

/** Response of GET /api/v1/nodes/{node}/file */
export type NodeFileResponse = {
  node: string;
  path: string;
  /** Bytes actually returned (after any truncation). */
  size: number;
  truncated: boolean;
  /** sha256 of the returned bytes. */
  sha256: string;
  /** True when the content contains NUL bytes. */
  binary: boolean;
  contentBase64: string;
};
