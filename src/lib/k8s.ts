/**
 * The console SDK surface this plugin uses, in one place.
 *
 * Every other module imports Kubernetes access from here rather than from
 * `@openshift-console/dynamic-plugin-sdk` directly. The SDK is versioned with
 * the console, so a plugin supporting more than one console generation needs
 * somewhere for those differences to live; this is that place, and it is
 * deliberately the only file that names the package.
 *
 * The names below are this plugin's own vocabulary, which happens to match the
 * 4.22 SDK. Earlier SDKs export the same functions as `k8sGetResource` and
 * `k8sPatchResource` — 4.22 exports only the shortened aliases — so a release
 * branch for an older console changes the two lines here and nothing else:
 *
 *     export { k8sGetResource as k8sGet, k8sPatchResource as k8sPatch, ... }
 */
export {
  k8sGet,
  k8sPatch,
  useK8sWatchResource,
  Timestamp,
} from '@openshift-console/dynamic-plugin-sdk';

export type {
  K8sModel,
  K8sResourceCommon,
} from '@openshift-console/dynamic-plugin-sdk';
