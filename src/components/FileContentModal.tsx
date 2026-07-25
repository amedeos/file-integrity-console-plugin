import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Bullseye,
  Button,
  ClipboardCopy,
  ClipboardCopyVariant,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Spinner,
} from '@patternfly/react-core';
import { I18N_NS } from '../constants';
import { NodeFileResponse } from '../types';
import { BackendError, decodeBase64, fetchNodeFile, hexDump } from '../lib/backend';

type Props = {
  node: string;
  fileIntegrity: string;
  path: string;
  onClose: () => void;
};

const humanBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`;

/**
 * Turns a backend failure into an explanation the reader can act on.
 *
 * The distinction matters: a 403 from the policy means "nobody may read this
 * path through this tool", while a 403 from the API server means "you may not,
 * but someone else could". Both arrive as 403, so the backend's message is
 * what carries the difference and we show it verbatim.
 */
const useErrorText = () => {
  const { t } = useTranslation(I18N_NS);
  return (error: unknown): { title: string; body: string } => {
    if (error instanceof BackendError) {
      switch (error.status) {
        case 401:
          return {
            title: t('Not authenticated'),
            body: t(
              'The console did not forward your credentials to the plugin backend. Reload the page and try again.',
            ),
          };
        case 403:
          return { title: t('Not allowed'), body: error.message };
        case 404:
          return {
            title: t('Not found'),
            body: t(
              'No running File Integrity scan pod was found on this node, or the file no longer exists: {{detail}}',
              { detail: error.message },
            ),
          };
        case 501:
          return {
            title: t('Feature disabled'),
            body: t(
              'Reading files from nodes is disabled in this installation. An administrator can enable it in the plugin Helm values.',
            ),
          };
        default:
          return { title: t('Could not read the file'), body: error.message };
      }
    }
    return {
      title: t('Could not read the file'),
      body: (error as Error)?.message ?? String(error),
    };
  };
};

export const FileContentModal: React.FC<Props> = ({
  node,
  fileIntegrity,
  path,
  onClose,
}) => {
  const { t } = useTranslation(I18N_NS);
  const errorText = useErrorText();
  const [result, setResult] = React.useState<NodeFileResponse>();
  const [error, setError] = React.useState<unknown>();
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    setResult(undefined);

    fetchNodeFile(node, path, fileIntegrity, controller.signal)
      .then((r) => {
        setResult(r);
        setLoading(false);
      })
      .catch((e) => {
        if ((e as Error)?.name !== 'AbortError') {
          setError(e);
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [node, path, fileIntegrity]);

  const bytes = React.useMemo(
    () => (result ? decodeBase64(result.contentBase64) : undefined),
    [result],
  );

  const text = React.useMemo(() => {
    if (!result || !bytes) {
      return '';
    }
    return result.binary ? hexDump(bytes) : new TextDecoder().decode(bytes);
  }, [result, bytes]);

  const onDownload = () => {
    if (!bytes) {
      return;
    }
    const blob = new Blob([bytes as BlobPart], {
      type: 'application/octet-stream',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = path.split('/').pop() || 'file';
    a.click();
    URL.revokeObjectURL(url);
  };

  const rendered = error ? errorText(error) : undefined;

  return (
    <Modal isOpen variant="large" onClose={onClose}>
      <ModalHeader title={path} />
      <ModalBody>
        <DescriptionList isHorizontal isCompact>
          <DescriptionListGroup>
            <DescriptionListTerm>{t('Node')}</DescriptionListTerm>
            <DescriptionListDescription>{node}</DescriptionListDescription>
          </DescriptionListGroup>
          {result ? (
            <>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('Size read')}</DescriptionListTerm>
                <DescriptionListDescription>
                  {humanBytes(result.size)}
                </DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>
                  {t('SHA-256 of bytes read')}
                </DescriptionListTerm>
                <DescriptionListDescription>
                  <ClipboardCopy
                    isReadOnly
                    hoverTip={t('Copy')}
                    clickTip={t('Copied')}
                    variant={ClipboardCopyVariant.inlineCompact}
                  >
                    {result.sha256}
                  </ClipboardCopy>
                </DescriptionListDescription>
              </DescriptionListGroup>
            </>
          ) : null}
        </DescriptionList>

        {result?.truncated ? (
          <Alert
            variant="warning"
            isInline
            className="pf-v6-u-mt-md"
            title={t('Output truncated')}
          >
            {t(
              'Only the first {{size}} were read. The SHA-256 above covers the bytes shown, not the whole file.',
              { size: humanBytes(result.size) },
            )}
          </Alert>
        ) : null}

        {result?.binary ? (
          <Alert
            variant="info"
            isInline
            className="pf-v6-u-mt-md"
            title={t('Binary file')}
          >
            {t('The content is shown as a hex dump. Use Download for the raw bytes.')}
          </Alert>
        ) : null}

        <div className="pf-v6-u-mt-md">
          {loading ? (
            <Bullseye>
              <Spinner />
            </Bullseye>
          ) : rendered ? (
            <Alert variant="danger" isInline title={rendered.title}>
              {rendered.body}
            </Alert>
          ) : (
            <pre
              style={{
                maxHeight: '50vh',
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                background: 'var(--pf-t--global--background--color--secondary--default)',
                padding: 'var(--pf-t--global--spacer--md)',
              }}
            >
              {text}
            </pre>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        {result ? (
          <Button variant="secondary" onClick={onDownload}>
            {t('Download')}
          </Button>
        ) : null}
        <Button variant="link" onClick={onClose}>
          {t('Close')}
        </Button>
      </ModalFooter>
    </Modal>
  );
};
