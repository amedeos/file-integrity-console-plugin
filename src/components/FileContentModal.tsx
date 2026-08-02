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
import type { NodeFileResponse } from '../types';
import { errorMessage } from '../lib/errors';
import { CSS, TOKEN } from '../lib/styles';
import {
  BackendError,
  decodeBase64,
  fetchNodeFile,
  hexDump,
} from '../lib/backend';

interface Props {
  node: string;
  fileIntegrity: string;
  path: string;
  onClose: () => void;
}

const humanBytes = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KiB`
      : `${(n / 1024 / 1024).toFixed(1)} MiB`;

/**
 * Turns a backend failure into an explanation the reader can act on.
 *
 * The distinction matters: a 403 from the policy means "nobody may read this
 * path through this tool", while a 403 from the API server means "you may not,
 * but someone else could". Both arrive as 403, so the backend's message is
 * what carries the difference and we show it verbatim.
 *
 * Which is only sound while the backend is what answered. A status on its own
 * says nothing about who produced it: the console's plugin proxy sits in front
 * and refuses in the same numbers. Every one of the explanations below is
 * about something the *backend* found, so none of them may be shown for a
 * response the backend did not send — hence the check before the switch rather
 * than a special case inside it.
 */
const useErrorText = () => {
  const { t } = useTranslation(I18N_NS);
  return (error: unknown): { title: string; body: string } => {
    if (error instanceof BackendError) {
      if (!error.fromBackend) {
        return {
          title: t('Could not reach the plugin backend'),
          body: t(
            'The request was refused with HTTP {{status}} before it reached the plugin, so the file was never looked for and this says nothing about the node. The usual cause is the console’s plugin proxy: check that the ConsolePlugin resource declares the backend’s proxy alias and that the plugin’s pod is running.',
            { status: error.status },
          ),
        };
      }
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
            // Deliberately does not name the mechanism. The plugin can be
            // installed from a Helm chart or from OperatorHub, and the two are
            // turned on in entirely different places; naming one sends half the
            // administrators looking for a file that does not exist on their
            // cluster, which is exactly what the earlier wording did.
            body: t(
              'Reading files from nodes is disabled in this installation. A cluster administrator can enable it; see the plugin documentation.',
            ),
          };
        default:
          return { title: t('Could not read the file'), body: error.message };
      }
    }
    return {
      title: t('Could not read the file'),
      body: errorMessage(error),
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

  // Reset during render rather than inside the effect: if the modal is pointed
  // at a different file without unmounting, an effect-time reset would paint
  // the previous file's contents under the new file's name first.
  // Joined on an escaped NUL, which cannot occur in a node name or in any
  // path the backend accepts, so no two distinct inputs collide into one key.
  // Escaped rather than literal: a raw NUL byte makes grep and git treat the
  // whole file as binary and skip it in silence, which is how the PatternFly
  // class names in this file survived a repository-wide search for them that
  // reported none.
  const requestKey = [node, fileIntegrity, path].join('\u0000');
  const [requestedFor, setRequestedFor] = React.useState(requestKey);
  if (requestKey !== requestedFor) {
    setRequestedFor(requestKey);
    setLoading(true);
    setError(undefined);
    setResult(undefined);
  }

  React.useEffect(() => {
    const controller = new AbortController();

    fetchNodeFile(node, path, fileIntegrity, controller.signal)
      .then((r) => {
        setResult(r);
        setLoading(false);
      })
      .catch((e: unknown) => {
        // A non-Error rejection is not an abort, so it has to surface.
        if (!(e instanceof Error) || e.name !== 'AbortError') {
          setError(e);
          setLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
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
    // Not `??`: a path ending in a slash makes pop() return "", which is not a
    // usable download name either, so both cases need the fallback.
    const basename = path.split('/').pop();
    a.download = basename === undefined || basename === '' ? 'file' : basename;
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
            className={CSS.marginTopMd}
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
            className={CSS.marginTopMd}
            title={t('Binary file')}
          >
            {t(
              'The content is shown as a hex dump. Use Download for the raw bytes.',
            )}
          </Alert>
        ) : null}

        <div className={CSS.marginTopMd}>
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
                background: TOKEN.backgroundSecondary,
                padding: TOKEN.spacerMd,
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
