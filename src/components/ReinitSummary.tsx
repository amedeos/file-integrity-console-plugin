import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
} from '@patternfly/react-core';
import { I18N_NS } from '../constants';
import type { ReinitCause } from '../constants';
import { CSS } from '../lib/styles';

/**
 * Baseline re-initialisations in the window, split by what caused them.
 *
 * Cluster-wide rather than per node, because the operator's counter carries no
 * `node` label — read off a cluster, and the reason this panel lives on the
 * overview.
 *
 * The split is the point. `demand` is a re-init somebody asked for, which on
 * this cluster mostly means the button in this plugin; `config` and `node` are
 * the operator's own doing. Nowhere else does the effect of the plugin's own
 * action show up as a number, which is most of why this earns its space.
 *
 * Zero is a real answer here, not missing data: a counter nobody has
 * incremented does not exist as a series at all.
 */
export const ReinitSummary: React.FC<{
  counts: Record<ReinitCause, number>;
  total: number;
}> = ({ counts, total }) => {
  const { t } = useTranslation(I18N_NS);

  if (total === 0) {
    return (
      <span className={CSS.textSecondary}>
        {t('No baselines were re-initialized in this window.')}
      </span>
    );
  }

  const label: Record<ReinitCause, string> = {
    demand: t('Requested'),
    node: t('After a node change'),
    config: t('After a configuration change'),
  };

  const description: Record<ReinitCause, string> = {
    demand: t('Asked for by a person, including from this plugin.'),
    node: t('Started by the operator when a node changed.'),
    config: t('Started by the operator when the AIDE configuration changed.'),
  };

  return (
    <DescriptionList isHorizontal isCompact>
      {(Object.keys(label) as ReinitCause[]).map((cause) => (
        <DescriptionListGroup key={cause}>
          <DescriptionListTerm>{label[cause]}</DescriptionListTerm>
          <DescriptionListDescription>
            {counts[cause]}
            <div className={`${CSS.fontSizeSm} ${CSS.textSecondary}`}>
              {description[cause]}
            </div>
          </DescriptionListDescription>
        </DescriptionListGroup>
      ))}
    </DescriptionList>
  );
};
