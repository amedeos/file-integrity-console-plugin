import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { ToggleGroup, ToggleGroupItem } from '@patternfly/react-core';
import { I18N_NS } from '../constants';
import { TIMESPANS } from '../lib/series';
import type { Timespan } from '../lib/series';

/** How long a window the history panels cover. */
export const TimespanSelect: React.FC<{
  value: Timespan;
  onChange: (timespan: Timespan) => void;
}> = ({ value, onChange }) => {
  const { t } = useTranslation(I18N_NS);

  const label: Record<Timespan, string> = {
    '24h': t('24 hours'),
    '7d': t('7 days'),
    '30d': t('30 days'),
  };

  return (
    <ToggleGroup aria-label={t('Time range')}>
      {TIMESPANS.map((timespan) => (
        <ToggleGroupItem
          key={timespan}
          text={label[timespan]}
          isSelected={value === timespan}
          onChange={() => {
            onChange(timespan);
          }}
        />
      ))}
    </ToggleGroup>
  );
};
