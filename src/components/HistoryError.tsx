import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@patternfly/react-core';
import { FIO_NAMESPACE, I18N_NS } from '../constants';
import { errorMessage, httpStatus } from '../lib/errors';

/**
 * Shown when the query for the history failed rather than came back empty.
 *
 * The two are different situations with different remedies, which is why this
 * is not `MetricsUnavailable` with a redder border: empty means nobody is
 * collecting and a label fixes it, while this means the question could not be
 * asked at all.
 *
 * It says what happened instead of what the transport said. The first version
 * printed `errorMessage(error)` straight into the alert, and a console with no
 * Prometheus proxy configured produced the single word **Not Found** —
 * observed in a browser. That names neither what was not found nor whether the
 * results on the rest of the page are still to be trusted, which is the first
 * thing a reader wants to know when a panel breaks.
 *
 * Two cases are worth separating, because they send the reader to different
 * people. A refusal is the cluster's answer about *this* user and nobody else
 * is affected; anything else is the monitoring stack, and everyone sees it.
 * The underlying message is kept as detail rather than dropped — it is what an
 * administrator will want — but it is no longer the whole explanation.
 */
export const HistoryError: React.FC<{ error: unknown }> = ({ error }) => {
  const { t } = useTranslation(I18N_NS);
  const status = httpStatus(error);
  const refused = status === 401 || status === 403;

  return (
    <Alert
      variant="warning"
      isInline
      title={
        refused
          ? t('Not allowed to read the history')
          : t('Could not read the history')
      }
    >
      <p>
        {refused
          ? t(
              'You are not allowed to query monitoring data for the {{fioNamespace}} namespace, so there is nothing to show over time. The results below are unaffected.',
              { fioNamespace: FIO_NAMESPACE },
            )
          : t(
              'The console could not reach the cluster’s monitoring, so there is nothing to show over time. The results below are unaffected.',
            )}
      </p>
      <p>
        {t('The query failed with: {{detail}}', {
          detail: errorMessage(error),
        })}
      </p>
    </Alert>
  );
};
