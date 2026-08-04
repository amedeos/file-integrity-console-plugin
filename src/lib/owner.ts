import type { FileIntegrity, FileIntegrityNodeStatus } from '../types';

/**
 * The FileIntegrity a node status belongs to, resolved through its
 * ownerReferences.
 *
 * A cluster may carry more than one FileIntegrity — one for the control plane
 * and one for the workers is the arrangement the operator's own documentation
 * suggests — and each produces its own FileIntegrityNodeStatus per node it
 * covers. The node's name is therefore not a key: two selectors that overlap
 * produce two statuses for the same node, and they can disagree.
 *
 * The fallback covers a status whose ownerReferences are missing, which is only
 * unambiguous when there is a single FileIntegrity to attribute it to. With
 * several, guessing would be worse than admitting we do not know.
 */
export const ownerOf = (
  status: FileIntegrityNodeStatus,
  fis: FileIntegrity[],
): FileIntegrity | undefined => {
  const ref = status.metadata?.ownerReferences?.find(
    (o) => o.kind === 'FileIntegrity',
  );
  if (ref) {
    return fis.find((fi) => fi.metadata?.name === ref.name);
  }
  return fis.length === 1 ? fis[0] : undefined;
};

/**
 * The status for one node *under one named FileIntegrity*.
 *
 * Both halves of the route are used on purpose. Searching by node name alone
 * returns whichever status the list happens to hold first, so on a cluster
 * where two FileIntegrity resources cover the same node the report shown, the
 * ConfigMap read and the resource the re-init button patches could belong to
 * three different answers to the same question — and nothing on the page would
 * say which.
 */
export const statusOf = (
  statuses: FileIntegrityNodeStatus[],
  fis: FileIntegrity[],
  fiName: string,
  nodeName: string,
): FileIntegrityNodeStatus | undefined =>
  statuses.find(
    (s) =>
      s.nodeName === nodeName && ownerOf(s, fis)?.metadata?.name === fiName,
  );
