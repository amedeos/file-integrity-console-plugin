import * as React from 'react';
import { useK8sModel } from './lib/k8s';
import { FILE_INTEGRITY_FLAG } from './constants';
import { FileIntegrityModel } from './models';

type SetFeatureFlag = (flag: string, enabled: boolean) => void;

/**
 * Sets `FILE_INTEGRITY` from the presence of the operator's CRD.
 *
 * This is what `console.flag/model` is for, and it is deliberately not what
 * this plugin uses. On consoles before 4.22 that extension is evaluated only
 * when API discovery completes: a plugin registering afterwards adds its model
 * to the console's internal map and nothing re-reads it. The console's own
 * source says as much — `frontend/public/reducers/features.ts` carries a
 * `TODO(vojtech): change of 'CRDs' should trigger relevant detection logic`
 * next to that code, and 4.22 fixed it by adding an `UpdateModelFlags` action
 * that re-evaluates late arrivals.
 *
 * That would be survivable if discovery ran again, but for a caller allowed to
 * watch CustomResourceDefinitions it does not: `startAPIDiscovery` runs it once
 * and then only on a CRD being added or removed. The 60-second poll is the
 * fallback for callers without that permission. So a plugin that loses the
 * startup race on 4.16 loses it until the page is reloaded — which is exactly
 * what was seen: the item missing on first load, present afterwards.
 *
 * A hook provider has no such ordering problem. The console mounts it through
 * `useResolvedExtensions`, so it runs whenever the plugin arrives, and
 * `useK8sModel` is a live selector: whether discovery lands before or after,
 * this re-renders and sets the flag. Nothing here is version-specific, so all
 * three generations use the same mechanism.
 */
export const useFileIntegrityFlag = (setFeatureFlag: SetFeatureFlag): void => {
  const [model, inFlight] = useK8sModel({
    group: FileIntegrityModel.apiGroup,
    version: FileIntegrityModel.apiVersion,
    kind: FileIntegrityModel.kind,
  });

  React.useEffect(() => {
    // Say nothing while discovery is still running: setting the flag false
    // first would render the navigation item, then remove it again.
    if (!inFlight) {
      setFeatureFlag(FILE_INTEGRITY_FLAG, Boolean(model));
    }
  }, [model, inFlight, setFeatureFlag]);
};
