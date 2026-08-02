import * as React from 'react';
import { Flex, FlexItem } from '@patternfly/react-core';

/**
 * A colour and what it means, side by side.
 *
 * Both history panels draw with the same three fills and so both have to say
 * what the fills are: a status colour never carries meaning on its own. The
 * first version of the band shipped without a legend, and a node that had been
 * failing all day drew a single red bar that said nothing about what red was.
 *
 * It lives in its own module rather than beside one of the panels because the
 * second panel needed it too, and a component imported sideways out of a
 * sibling is how two panels quietly become one file's business.
 */
export const LegendItem: React.FC<{ colour: string; label: string }> = ({
  colour,
  label,
}) => (
  <Flex
    spaceItems={{ default: 'spaceItemsSm' }}
    alignItems={{ default: 'alignItemsCenter' }}
    flexWrap={{ default: 'nowrap' }}
  >
    <FlexItem>
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: '10px',
          height: '10px',
          borderRadius: '2px',
          background: colour,
        }}
      />
    </FlexItem>
    <FlexItem>{label}</FlexItem>
  </Flex>
);
