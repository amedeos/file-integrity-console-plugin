import * as React from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Breadcrumb,
  BreadcrumbItem,
  Bullseye,
  Card,
  CardBody,
  CodeBlock,
  CodeBlockCode,
  Divider,
  ExpandableSection,
  Flex,
  FlexItem,
  Label,
  PageSection,
  Spinner,
  Title,
} from '@patternfly/react-core';
import { Timestamp } from '@openshift-console/dynamic-plugin-sdk';
import { ANNOTATIONS, I18N_NS } from '../constants';
import type { AideEntry, AideReport } from '../types';
import {
  useFileIntegrities,
  useNodeStatuses,
  useResultConfigMap,
} from '../hooks/useFileIntegrityData';
import { extractIntegrityLog, readCountAnnotation } from '../lib/decode';
import { countsMatch, parseAideReport } from '../lib/aide-parser';
import { isNodeHeldOff, isNodeReinitializing } from '../lib/reinit';
import { errorMessage } from '../lib/errors';
import { ConditionLabel } from './ConditionLabel';
import { AideReportTable } from './AideReportTable';
import { FileContentModal } from './FileContentModal';
import { ReinitNodeButton } from './ReinitActions';

const RawReport: React.FC<{ text: string }> = ({ text }) => (
  <CodeBlock>
    <CodeBlockCode style={{ maxHeight: '60vh', overflow: 'auto' }}>
      {text}
    </CodeBlockCode>
  </CodeBlock>
);

const NodeReportPage: React.FC = () => {
  const { t } = useTranslation(I18N_NS);
  const params = useParams<{ fiName: string; nodeName: string }>();
  // React Router types every param as optional; the route pattern guarantees
  // both are present, and an empty string simply matches nothing below.
  const fiName = params.fiName ?? '';
  const nodeName = params.nodeName ?? '';

  const [fis, fisLoaded] = useFileIntegrities();
  const [statuses, statusesLoaded] = useNodeStatuses();

  const fi = fis.find((f) => f.metadata?.name === fiName);
  const status = statuses.find((s) => s.nodeName === nodeName);
  const result = status?.lastResult;

  const {
    configMap,
    loaded: cmLoaded,
    error: cmError,
  } = useResultConfigMap(result?.resultConfigMapName);

  const [report, setReport] = React.useState<AideReport>();
  const [decodeError, setDecodeError] = React.useState<unknown>();
  const [retrieving, setRetrieving] = React.useState<AideEntry>();

  // Cleared during render rather than inside the effect below: effects run
  // after the browser has painted, so resetting there would show the previous
  // node's report for a frame.
  const [parsedFor, setParsedFor] = React.useState(configMap);
  if (configMap !== parsedFor) {
    setParsedFor(configMap);
    setReport(undefined);
    setDecodeError(undefined);
  }

  React.useEffect(() => {
    if (!configMap) {
      return undefined;
    }
    let cancelled = false;
    extractIntegrityLog(configMap)
      .then((text) => {
        if (!cancelled) {
          setReport(parseAideReport(text));
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setDecodeError(e);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [configMap]);

  const expectedCounts = React.useMemo(
    () =>
      configMap
        ? {
            added: readCountAnnotation(configMap, ANNOTATIONS.filesAdded),
            changed: readCountAnnotation(configMap, ANNOTATIONS.filesChanged),
            removed: readCountAnnotation(configMap, ANNOTATIONS.filesRemoved),
          }
        : {},
    [configMap],
  );

  // Opening the raw report is the user's call, so this has to be state:
  // passing isExpanded to ExpandableSection without an onToggle makes it a
  // controlled component that ignores its own toggle. It starts open only when
  // the parsed view cannot be trusted — a report we failed to parse, or one the
  // operator truncated.
  //
  // Adjusted during render rather than in an effect (the pattern React
  // documents for adjusting state when props change): the reset must happen for
  // a newly loaded report and nothing else, so a user who closes the section
  // keeps it closed.
  const [rawExpanded, setRawExpanded] = React.useState(false);
  const [expansionSetFor, setExpansionSetFor] = React.useState(report);
  if (report !== expansionSetFor) {
    setExpansionSetFor(report);
    setRawExpanded(report?.parseFailed === true || report?.truncated === true);
  }

  const loaded = fisLoaded && statusesLoaded;

  return (
    <>
      <PageSection>
        <Breadcrumb className="pf-v6-u-mb-md">
          <BreadcrumbItem>
            <Link to="/file-integrity">{t('File Integrity')}</Link>
          </BreadcrumbItem>
          <BreadcrumbItem isActive>{nodeName}</BreadcrumbItem>
        </Breadcrumb>
        <Flex
          justifyContent={{ default: 'justifyContentSpaceBetween' }}
          alignItems={{ default: 'alignItemsCenter' }}
        >
          <FlexItem>
            <Title headingLevel="h1">{nodeName}</Title>
            <Flex
              spaceItems={{ default: 'spaceItemsSm' }}
              className="pf-v6-u-mt-sm"
              alignItems={{ default: 'alignItemsCenter' }}
            >
              <FlexItem>
                <ConditionLabel condition={result?.condition} />
              </FlexItem>
              {isNodeReinitializing(fi, nodeName) ? (
                <FlexItem>
                  <Label color="blue" isCompact>
                    {t('Re-initializing')}
                  </Label>
                </FlexItem>
              ) : null}
              {isNodeHeldOff(fi, nodeName) ? (
                <FlexItem>
                  <Label color="grey" isCompact>
                    {t('Paused')}
                  </Label>
                </FlexItem>
              ) : null}
              {result?.lastProbeTime ? (
                <FlexItem>
                  <span className="pf-v6-u-color-200">
                    {t('Last scan')}{' '}
                    <Timestamp timestamp={result.lastProbeTime} />
                  </span>
                </FlexItem>
              ) : null}
            </Flex>
          </FlexItem>
          <FlexItem>
            <ReinitNodeButton fileIntegrity={fi} node={nodeName} />
          </FlexItem>
        </Flex>
      </PageSection>

      <Divider />

      <PageSection>
        {!loaded ? (
          <Bullseye>
            <Spinner />
          </Bullseye>
        ) : !status ? (
          <Alert variant="warning" isInline title={t('Node not found')}>
            {t(
              'No FileIntegrityNodeStatus exists for node {{node}}. It may have been removed from the cluster.',
              { node: nodeName },
            )}
          </Alert>
        ) : result?.condition === 'Errored' ? (
          <Alert
            variant="warning"
            isInline
            title={t('The scan did not complete')}
          >
            {result.errorMsg ??
              t('The operator reported an error without a message.')}
          </Alert>
        ) : result?.condition !== 'Failed' ? (
          <Alert variant="success" isInline title={t('No changes detected')}>
            {t(
              'AIDE found no differences between the baseline database and the filesystem on this node.',
            )}
          </Alert>
        ) : !cmLoaded ? (
          <Bullseye>
            <Spinner />
          </Bullseye>
        ) : cmError ? (
          <Alert
            variant="danger"
            isInline
            title={t('Could not load the report')}
          >
            {t('Reading ConfigMap {{name}} failed: {{message}}', {
              name: result.resultConfigMapName,
              message: errorMessage(cmError),
            })}
          </Alert>
        ) : decodeError ? (
          <Alert
            variant="danger"
            isInline
            title={t('Could not decode the report')}
          >
            {errorMessage(decodeError)}
          </Alert>
        ) : !report ? (
          <Bullseye>
            <Spinner />
          </Bullseye>
        ) : (
          <>
            {report.truncated ? (
              <Alert
                variant="warning"
                isInline
                className="pf-v6-u-mb-md"
                title={t('The report was too large to store')}
              >
                {t(
                  'The operator could not fit this report in a ConfigMap, so it stored a placeholder instead. The full report is on the node at /etc/kubernetes/aide.log.',
                )}
              </Alert>
            ) : null}

            {report.parseFailed && !report.truncated ? (
              <Alert
                variant="warning"
                isInline
                className="pf-v6-u-mb-md"
                title={t('This report could not be parsed')}
              >
                {t(
                  'The report is in a format this plugin does not recognise, possibly from a newer AIDE version. The raw text is shown below.',
                )}
              </Alert>
            ) : null}

            {!report.parseFailed &&
            !report.truncated &&
            !countsMatch(report, expectedCounts) ? (
              <Alert
                variant="warning"
                isInline
                className="pf-v6-u-mb-md"
                title={t('The parsed report is incomplete')}
              >
                {t(
                  'The operator recorded {{added}} added, {{changed}} changed and {{removed}} removed files, but only {{parsed}} entries could be parsed. Check the raw report below.',
                  {
                    added: expectedCounts.added ?? '?',
                    changed: expectedCounts.changed ?? '?',
                    removed: expectedCounts.removed ?? '?',
                    parsed: report.entries.length,
                  },
                )}
              </Alert>
            ) : null}

            {report.entries.length > 0 ? (
              <Card>
                <CardBody>
                  <AideReportTable report={report} onRetrieve={setRetrieving} />
                </CardBody>
              </Card>
            ) : null}

            <ExpandableSection
              className="pf-v6-u-mt-md"
              toggleTextExpanded={t('Hide raw AIDE report')}
              toggleTextCollapsed={t('Show raw AIDE report')}
              isExpanded={rawExpanded}
              onToggle={(_event, isExpanded) => {
                setRawExpanded(isExpanded);
              }}
            >
              <RawReport text={report.raw} />
            </ExpandableSection>
          </>
        )}
      </PageSection>

      {retrieving && fiName ? (
        <FileContentModal
          node={nodeName}
          fileIntegrity={fiName}
          path={retrieving.path}
          onClose={() => {
            setRetrieving(undefined);
          }}
        />
      ) : null}
    </>
  );
};

export default NodeReportPage;
