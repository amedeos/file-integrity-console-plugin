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
 * 4.22 SDK. Earlier SDKs export the same functions under the longer names
 * `k8sGetResource` and `k8sPatchResource` as well — verified in 1.2.0, which
 * serves consoles 4.16 to 4.18 — while 4.22 exports only the short aliases.
 * Using the short spelling therefore leaves this file identical on every
 * branch, despite its being one of the three that are allowed to differ.
 */
export {
  k8sGet,
  k8sPatch,
  useK8sModel,
  useK8sWatchResource,
  Timestamp,
} from '@openshift-console/dynamic-plugin-sdk';

export type {
  K8sModel,
  K8sResourceCommon,
} from '@openshift-console/dynamic-plugin-sdk';
