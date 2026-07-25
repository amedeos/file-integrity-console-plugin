import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  EmptyState,
  EmptyStateBody,
  Label,
  SearchInput,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  ToggleGroup,
  ToggleGroupItem,
  Tooltip,
} from '@patternfly/react-core';
import { FileIcon } from '@patternfly/react-icons';
import {
  ExpandableRowContent,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '@patternfly/react-table';
import { I18N_NS } from '../constants';
import { AideEntry, AideEntryKind, AideReport } from '../types';

type Props = {
  report: AideReport;
  /** Called when the user asks to read a file's current content from the node. */
  onRetrieve?: (entry: AideEntry) => void;
  /** Disables retrieval, e.g. when the backend feature is turned off. */
  retrieveDisabledReason?: string;
};

const KIND_ORDER: AideEntryKind[] = ['changed', 'added', 'removed'];

const KindLabel: React.FC<{ kind: AideEntryKind }> = ({ kind }) => {
  const { t } = useTranslation(I18N_NS);
  switch (kind) {
    case 'added':
      return <Label color="blue" isCompact>{t('Added')}</Label>;
    case 'removed':
      return <Label color="orange" isCompact>{t('Removed')}</Label>;
    default:
      return <Label color="red" isCompact>{t('Changed')}</Label>;
  }
};

/** Renders a value that may legitimately span several lines (ACLs, xattrs). */
const AttrValue: React.FC<{ value?: string }> = ({ value }) =>
  value === undefined ? (
    <span className="pf-v6-u-color-200">&mdash;</span>
  ) : (
    <code style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
      {value}
    </code>
  );

export const AideReportTable: React.FC<Props> = ({
  report,
  onRetrieve,
  retrieveDisabledReason,
}) => {
  const { t } = useTranslation(I18N_NS);
  const [search, setSearch] = React.useState('');
  const [kinds, setKinds] = React.useState<Set<AideEntryKind>>(
    new Set(KIND_ORDER),
  );
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  const toggleKind = (kind: AideEntryKind) => {
    const next = new Set(kinds);
    if (next.has(kind)) {
      next.delete(kind);
    } else {
      next.add(kind);
    }
    setKinds(next);
  };

  const rows = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    return report.entries.filter(
      (e) =>
        kinds.has(e.kind) && (!needle || e.path.toLowerCase().includes(needle)),
    );
  }, [report.entries, kinds, search]);

  const counts = React.useMemo(() => {
    const acc: Record<AideEntryKind, number> = {
      added: 0,
      changed: 0,
      removed: 0,
    };
    report.entries.forEach((e) => {
      acc[e.kind] += 1;
    });
    return acc;
  }, [report.entries]);

  return (
    <>
      <Toolbar>
        <ToolbarContent>
          <ToolbarItem>
            <SearchInput
              aria-label={t('Search by path')}
              placeholder={t('Search by path')}
              value={search}
              onChange={(_e, value) => setSearch(value)}
              onClear={() => setSearch('')}
            />
          </ToolbarItem>
          <ToolbarItem>
            <ToggleGroup aria-label={t('Filter by change type')}>
              {KIND_ORDER.map((kind) => (
                <ToggleGroupItem
                  key={kind}
                  text={`${
                    kind === 'added'
                      ? t('Added')
                      : kind === 'removed'
                        ? t('Removed')
                        : t('Changed')
                  } (${counts[kind]})`}
                  isSelected={kinds.has(kind)}
                  onChange={() => toggleKind(kind)}
                />
              ))}
            </ToggleGroup>
          </ToolbarItem>
        </ToolbarContent>
      </Toolbar>

      {rows.length === 0 ? (
        <EmptyState headingLevel="h4" titleText={t('No matching files')}>
          <EmptyStateBody>
            {t('Adjust the search text or the change type filters.')}
          </EmptyStateBody>
        </EmptyState>
      ) : (
        <Table aria-label={t('Detected file changes')} variant="compact">
          <Thead>
            <Tr>
              <Th screenReaderText={t('Expand row')} />
              <Th width={15}>{t('Change')}</Th>
              <Th>{t('Path on node')}</Th>
              <Th width={20}>{t('AIDE flags')}</Th>
              <Th width={15}>{t('Content')}</Th>
            </Tr>
          </Thead>
          {rows.map((entry, index) => {
            const isExpanded = expanded.has(entry.path);
            const hasDetails = entry.attrs.length > 0;
            // AIDE reports the file as it was; a removed file cannot be read
            // back and an added one has no recorded "before" to compare with,
            // but both still exist (or not) on disk, so only removals are
            // genuinely unreadable.
            const canRetrieve = onRetrieve && entry.kind !== 'removed';
            return (
              <Tbody key={entry.path} isExpanded={isExpanded}>
                <Tr>
                  <Td
                    expand={
                      hasDetails
                        ? {
                            rowIndex: index,
                            isExpanded,
                            onToggle: () => {
                              const next = new Set(expanded);
                              if (next.has(entry.path)) {
                                next.delete(entry.path);
                              } else {
                                next.add(entry.path);
                              }
                              setExpanded(next);
                            },
                          }
                        : undefined
                    }
                  />
                  <Td dataLabel={t('Change')}>
                    <KindLabel kind={entry.kind} />
                  </Td>
                  <Td dataLabel={t('Path on node')} modifier="breakWord">
                    <code>{entry.path}</code>
                  </Td>
                  <Td dataLabel={t('AIDE flags')}>
                    <code className="pf-v6-u-font-size-sm">
                      {entry.changeFlags ?? '-'}
                    </code>
                  </Td>
                  <Td dataLabel={t('Content')}>
                    {canRetrieve ? (
                      retrieveDisabledReason ? (
                        <Tooltip content={retrieveDisabledReason}>
                          <Button
                            variant="link"
                            isInline
                            isAriaDisabled
                            icon={<FileIcon />}
                          >
                            {t('View file')}
                          </Button>
                        </Tooltip>
                      ) : (
                        <Button
                          variant="link"
                          isInline
                          icon={<FileIcon />}
                          onClick={() => onRetrieve(entry)}
                        >
                          {t('View file')}
                        </Button>
                      )
                    ) : (
                      <span className="pf-v6-u-color-200">
                        {entry.kind === 'removed' ? t('Deleted') : '-'}
                      </span>
                    )}
                  </Td>
                </Tr>
                {hasDetails ? (
                  <Tr isExpanded={isExpanded}>
                    <Td />
                    <Td colSpan={4}>
                      <ExpandableRowContent>
                        <Table
                          aria-label={t('Attribute changes for {{path}}', {
                            path: entry.path,
                          })}
                          variant="compact"
                          borders={false}
                        >
                          <Thead>
                            <Tr>
                              <Th width={15}>{t('Attribute')}</Th>
                              <Th>{t('Recorded in baseline')}</Th>
                              <Th>{t('Found on disk')}</Th>
                            </Tr>
                          </Thead>
                          <Tbody>
                            {entry.attrs.map((attr) => (
                              <Tr key={attr.name}>
                                <Td dataLabel={t('Attribute')}>{attr.name}</Td>
                                <Td dataLabel={t('Recorded in baseline')}>
                                  <AttrValue value={attr.old} />
                                </Td>
                                <Td dataLabel={t('Found on disk')}>
                                  <AttrValue value={attr.new} />
                                </Td>
                              </Tr>
                            ))}
                          </Tbody>
                        </Table>
                      </ExpandableRowContent>
                    </Td>
                  </Tr>
                ) : null}
              </Tbody>
            );
          })}
        </Table>
      )}
    </>
  );
};
