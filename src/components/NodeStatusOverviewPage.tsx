import * as React from 'react';
import { Link } from '../lib/router';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Bullseye,
  Card,
  CardBody,
  CardTitle,
  EmptyState,
  EmptyStateBody,
  Flex,
  FlexItem,
  Gallery,
  Label,
  PageSection,
  SearchInput,
  Spinner,
  Title,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  ToggleGroup,
  ToggleGroupItem,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { Timestamp } from '../lib/k8s';
import { I18N_NS } from '../constants';
import type {
  FileIntegrity,
  FileIntegrityNodeStatus,
  NodeCondition,
} from '../types';
import {
  useFileIntegrities,
  useNodeStatuses,
} from '../hooks/useFileIntegrityData';
import { isNodeHeldOff, isNodeReinitializing } from '../lib/reinit';
import { errorMessage } from '../lib/errors';
import { CSS, TOKEN } from '../lib/styles';
import { ConditionLabel } from './ConditionLabel';
import { ReinitBulkActions } from './ReinitActions';

type Filter = 'All' | NodeCondition;

/** Owner FileIntegrity of a node status, resolved via its ownerReferences. */
const ownerOf = (
  status: FileIntegrityNodeStatus,
  fis: FileIntegrity[],
): FileIntegrity | undefined => {
  const ref = status.metadata?.ownerReferences?.find(
    (o) => o.kind === 'FileIntegrity',
  );
  if (ref) {
    return fis.find((fi) => fi.metadata?.name === ref.name);
  }
  // Fall back to the single configured FileIntegrity, which is the common case.
  return fis.length === 1 ? fis[0] : undefined;
};

const CountCard: React.FC<{
  title: string;
  count: number;
  variant?: 'danger' | 'warning' | 'success' | 'default';
}> = ({ title, count, variant = 'default' }) => (
  <Card isCompact isPlain>
    <CardTitle>{title}</CardTitle>
    <CardBody>
      <Title
        headingLevel="h2"
        size="3xl"
        style={{
          color:
            variant === 'danger'
              ? TOKEN.statusDanger
              : variant === 'warning'
                ? TOKEN.statusWarning
                : variant === 'success'
                  ? TOKEN.statusSuccess
                  : undefined,
        }}
      >
        {count}
      </Title>
    </CardBody>
  </Card>
);

const NodeStatusOverviewPage: React.FC = () => {
  const { t } = useTranslation(I18N_NS);
  const [fis, fisLoaded, fisError] = useFileIntegrities();
  const [statuses, statusesLoaded, statusesError] = useNodeStatuses();

  const [search, setSearch] = React.useState('');
  const [filter, setFilter] = React.useState<Filter>('All');

  const counts = React.useMemo(() => {
    const acc = { Succeeded: 0, Failed: 0, Errored: 0, Unknown: 0 };
    statuses.forEach((s) => {
      const c = s.lastResult?.condition;
      if (c === 'Succeeded' || c === 'Failed' || c === 'Errored') {
        acc[c] += 1;
      } else {
        acc.Unknown += 1;
      }
    });
    return acc;
  }, [statuses]);

  const rows = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    return statuses
      .filter((s) => {
        const condition = s.lastResult?.condition;
        if (filter !== 'All' && condition !== filter) {
          return false;
        }
        return !needle || (s.nodeName ?? '').toLowerCase().includes(needle);
      })
      .sort((a, b) => {
        // Surface the nodes that need attention first.
        const rank = (s: FileIntegrityNodeStatus) =>
          s.lastResult?.condition === 'Failed'
            ? 0
            : s.lastResult?.condition === 'Errored'
              ? 1
              : 2;
        return (
          rank(a) - rank(b) ||
          (a.nodeName ?? '').localeCompare(b.nodeName ?? '')
        );
      });
  }, [statuses, search, filter]);

  const loaded = fisLoaded && statusesLoaded;
  const error = fisError ?? statusesError;

  return (
    <>
      <PageSection>
        <Flex
          justifyContent={{ default: 'justifyContentSpaceBetween' }}
          alignItems={{ default: 'alignItemsCenter' }}
        >
          <FlexItem>
            <Title headingLevel="h1">{t('File Integrity')}</Title>
            <p>
              {t(
                'AIDE scan results reported by the File Integrity Operator, node by node.',
              )}
            </p>
          </FlexItem>
          <FlexItem>
            <ReinitBulkActions fileIntegrities={fis} />
          </FlexItem>
        </Flex>
      </PageSection>

      {error ? (
        <PageSection>
          <Alert
            variant="danger"
            isInline
            title={t('Could not load File Integrity data')}
          >
            {errorMessage(error)}
          </Alert>
        </PageSection>
      ) : null}

      {!loaded ? (
        <PageSection>
          <Bullseye>
            <Spinner />
          </Bullseye>
        </PageSection>
      ) : (
        <>
          <PageSection>
            <Gallery hasGutter minWidths={{ default: '160px' }}>
              <CountCard
                title={t('Changes detected')}
                count={counts.Failed}
                variant="danger"
              />
              <CountCard
                title={t('Scan errors')}
                count={counts.Errored}
                variant="warning"
              />
              <CountCard
                title={t('No changes')}
                count={counts.Succeeded}
                variant="success"
              />
              <CountCard title={t('No result yet')} count={counts.Unknown} />
            </Gallery>
          </PageSection>

          <PageSection>
            <Toolbar>
              <ToolbarContent>
                <ToolbarItem>
                  <SearchInput
                    aria-label={t('Search by node name')}
                    placeholder={t('Search by node name')}
                    value={search}
                    onChange={(_e, value) => {
                      setSearch(value);
                    }}
                    onClear={() => {
                      setSearch('');
                    }}
                  />
                </ToolbarItem>
                <ToolbarItem>
                  <ToggleGroup aria-label={t('Filter by result')}>
                    {(
                      ['All', 'Failed', 'Errored', 'Succeeded'] as Filter[]
                    ).map((f) => (
                      <ToggleGroupItem
                        key={f}
                        text={
                          f === 'All'
                            ? t('All')
                            : f === 'Failed'
                              ? t('Changes detected')
                              : f === 'Errored'
                                ? t('Scan error')
                                : t('No changes')
                        }
                        isSelected={filter === f}
                        onChange={() => {
                          setFilter(f);
                        }}
                      />
                    ))}
                  </ToggleGroup>
                </ToolbarItem>
              </ToolbarContent>
            </Toolbar>

            {statuses.length === 0 ? (
              <EmptyState
                headingLevel="h4"
                titleText={t('No scan results yet')}
              >
                <EmptyStateBody>
                  {fis.length === 0
                    ? t(
                        'No FileIntegrity resource exists. Create one in the openshift-file-integrity namespace to start scanning nodes.',
                      )
                    : t(
                        'The operator has not reported any node status yet. Building the initial AIDE database takes several minutes per node.',
                      )}
                </EmptyStateBody>
              </EmptyState>
            ) : (
              <Table aria-label={t('Node integrity status')} variant="compact">
                <Thead>
                  <Tr>
                    <Th>{t('Node')}</Th>
                    <Th>{t('Result')}</Th>
                    <Th>{t('Added')}</Th>
                    <Th>{t('Changed')}</Th>
                    <Th>{t('Removed')}</Th>
                    <Th>{t('Last scan')}</Th>
                    <Th>{t('FileIntegrity')}</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {rows.map((s) => {
                    const node = s.nodeName ?? '';
                    const result = s.lastResult;
                    const fi = ownerOf(s, fis);
                    const fiName = fi?.metadata?.name;
                    const failed = result?.condition === 'Failed';
                    return (
                      <Tr key={s.metadata?.uid ?? node}>
                        <Td dataLabel={t('Node')}>
                          {fiName && failed ? (
                            <Link
                              to={`/file-integrity/${fiName}/nodes/${node}`}
                            >
                              {node}
                            </Link>
                          ) : (
                            node
                          )}
                        </Td>
                        <Td dataLabel={t('Result')}>
                          <Flex
                            spaceItems={{ default: 'spaceItemsSm' }}
                            alignItems={{ default: 'alignItemsCenter' }}
                          >
                            <FlexItem>
                              <ConditionLabel condition={result?.condition} />
                            </FlexItem>
                            {isNodeReinitializing(fi, node) ? (
                              <FlexItem>
                                <Label color="blue" isCompact>
                                  {t('Re-initializing')}
                                </Label>
                              </FlexItem>
                            ) : null}
                            {isNodeHeldOff(fi, node) ? (
                              <FlexItem>
                                <Label color="grey" isCompact>
                                  {t('Paused')}
                                </Label>
                              </FlexItem>
                            ) : null}
                          </Flex>
                          {result?.condition === 'Errored' &&
                          result.errorMsg ? (
                            <div
                              className={`${CSS.fontSizeSm} ${CSS.textSecondary}`}
                            >
                              {result.errorMsg}
                            </div>
                          ) : null}
                        </Td>
                        <Td dataLabel={t('Added')}>
                          {failed ? (result.filesAdded ?? 0) : '-'}
                        </Td>
                        <Td dataLabel={t('Changed')}>
                          {failed ? (result.filesChanged ?? 0) : '-'}
                        </Td>
                        <Td dataLabel={t('Removed')}>
                          {failed ? (result.filesRemoved ?? 0) : '-'}
                        </Td>
                        <Td dataLabel={t('Last scan')}>
                          {result?.lastProbeTime ? (
                            <Timestamp timestamp={result.lastProbeTime} />
                          ) : (
                            '-'
                          )}
                        </Td>
                        <Td dataLabel={t('FileIntegrity')}>{fiName ?? '-'}</Td>
                      </Tr>
                    );
                  })}
                </Tbody>
              </Table>
            )}
          </PageSection>
        </>
      )}
    </>
  );
};

export default NodeStatusOverviewPage;
