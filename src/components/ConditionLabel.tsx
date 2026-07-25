import * as React from 'react';
import { Label } from '@patternfly/react-core';
import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  QuestionCircleIcon,
} from '@patternfly/react-icons';
import { useTranslation } from 'react-i18next';
import { I18N_NS } from '../constants';
import { NodeCondition } from '../types';

type ConditionLabelProps = {
  condition?: NodeCondition;
};

/**
 * Renders a FileIntegrityNodeStatus condition.
 *
 * `Failed` means AIDE found differences, which is the case an operator has to
 * act on, so it gets the strongest styling. `Errored` means the scan itself did
 * not complete — also bad, but a different kind of bad.
 */
export const ConditionLabel: React.FC<ConditionLabelProps> = ({ condition }) => {
  const { t } = useTranslation(I18N_NS);

  switch (condition) {
    case 'Succeeded':
      return (
        <Label color="green" icon={<CheckCircleIcon />}>
          {t('No changes')}
        </Label>
      );
    case 'Failed':
      return (
        <Label color="red" icon={<ExclamationCircleIcon />}>
          {t('Changes detected')}
        </Label>
      );
    case 'Errored':
      return (
        <Label color="orange" icon={<ExclamationTriangleIcon />}>
          {t('Scan error')}
        </Label>
      );
    default:
      return (
        <Label color="grey" icon={<QuestionCircleIcon />}>
          {t('No result yet')}
        </Label>
      );
  }
};
