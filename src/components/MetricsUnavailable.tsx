import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@patternfly/react-core';
import { FIO_NAMESPACE, I18N_NS } from '../constants';

/**
 * Shown when nothing is collecting the operator's metrics.
 *
 * This is the state most clusters are in to begin with, and it is worth saying
 * out loud rather than drawing an empty chart: on a fresh install the
 * operator's namespace carries no `openshift.io/cluster-monitoring` label, so
 * its ServiceMonitor sits there and nobody scrapes it. Observed on a 4.16
 * cluster; adding the label made the series appear inside ninety seconds.
 *
 * The remedy is the cluster's to apply and not ours — the plugin holds no
 * permission anywhere near a namespace label, and should not. So this says what
 * to do and stops.
 */
export const MetricsUnavailable: React.FC = () => {
  const { t } = useTranslation(I18N_NS);

  return (
    <Alert variant="info" isInline title={t('No history is being recorded')}>
      <p>
        {t(
          'Nothing is collecting the File Integrity Operator’s metrics, so there is nothing to show over time. Current results are unaffected.',
        )}
      </p>
      <p>
        {t('A cluster administrator can start collection with:')}{' '}
        <code>
          oc label namespace {FIO_NAMESPACE}{' '}
          openshift.io/cluster-monitoring=true
        </code>
      </p>
    </Alert>
  );
};
