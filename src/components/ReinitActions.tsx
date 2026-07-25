import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Content,
  Dropdown,
  DropdownItem,
  DropdownList,
  MenuToggle,
  MenuToggleElement,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
} from '@patternfly/react-core';
import { k8sPatch } from '@openshift-console/dynamic-plugin-sdk';
import { ANNOTATIONS, I18N_NS } from '../constants';
import { FileIntegrityModel } from '../models';
import { FileIntegrity } from '../types';
import { addNodeToReinit, setAnnotationPatch } from '../lib/reinit';

type ConfirmState = {
  title: string;
  body: React.ReactNode;
  run: () => Promise<unknown>;
};

/**
 * Shared confirmation modal. Re-initialising discards the current AIDE baseline
 * and adopts whatever is on disk right now as the new "known good" state, so it
 * must never happen on a single click.
 */
const ReinitConfirmModal: React.FC<{
  state?: ConfirmState;
  onClose: () => void;
}> = ({ state, onClose }) => {
  const { t } = useTranslation(I18N_NS);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string>();

  React.useEffect(() => {
    setError(undefined);
    setSubmitting(false);
  }, [state]);

  if (!state) {
    return null;
  }

  const onConfirm = async () => {
    setSubmitting(true);
    setError(undefined);
    try {
      await state.run();
      onClose();
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen variant="medium" onClose={onClose}>
      <ModalHeader title={state.title} titleIconVariant="warning" />
      <ModalBody>
        <Content component="p">{state.body}</Content>
        <Content component="p">
          {t(
            'The current AIDE database is discarded and rebuilt from the files as they are on disk now. Everything currently reported as added, changed or removed stops being reported, including any change that turns out to be an intrusion. Only do this once you have reviewed the outstanding findings.',
          )}
        </Content>
        {error ? (
          <Alert variant="danger" isInline title={t('Request failed')}>
            {error}
          </Alert>
        ) : null}
      </ModalBody>
      <ModalFooter>
        <Button
          variant="danger"
          onClick={onConfirm}
          isLoading={submitting}
          isDisabled={submitting}
        >
          {t('Re-initialize baseline')}
        </Button>
        <Button variant="link" onClick={onClose} isDisabled={submitting}>
          {t('Cancel')}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

const patchAnnotation = (fi: FileIntegrity, key: string, value: string) =>
  k8sPatch({
    model: FileIntegrityModel,
    resource: fi,
    data: setAnnotationPatch(fi, key, value),
  });

/** Per-node re-init button, shown on a node's report page. */
export const ReinitNodeButton: React.FC<{
  fileIntegrity?: FileIntegrity;
  node: string;
}> = ({ fileIntegrity, node }) => {
  const { t } = useTranslation(I18N_NS);
  const [confirm, setConfirm] = React.useState<ConfirmState>();

  if (!fileIntegrity) {
    return null;
  }

  const onClick = () =>
    setConfirm({
      title: t('Re-initialize the baseline for {{node}}?', { node }),
      body: t(
        'The File Integrity Operator will rebuild the AIDE database on {{node}}.',
        { node },
      ),
      run: async () => {
        const current =
          fileIntegrity.metadata?.annotations?.[ANNOTATIONS.reinit];
        const next = addNodeToReinit(current, node);
        if (next === undefined) {
          // Already covered by an in-flight request; nothing to send.
          return undefined;
        }
        return patchAnnotation(fileIntegrity, ANNOTATIONS.reinit, next);
      },
    });

  return (
    <>
      <Button variant="secondary" onClick={onClick}>
        {t('Re-initialize baseline')}
      </Button>
      <ReinitConfirmModal
        state={confirm}
        onClose={() => setConfirm(undefined)}
      />
    </>
  );
};

/** Cluster-wide re-init actions, shown in the overview header. */
export const ReinitBulkActions: React.FC<{
  fileIntegrities: FileIntegrity[];
}> = ({ fileIntegrities }) => {
  const { t } = useTranslation(I18N_NS);
  const [open, setOpen] = React.useState(false);
  const [confirm, setConfirm] = React.useState<ConfirmState>();

  if (fileIntegrities.length === 0) {
    return null;
  }

  const forEachFi = (key: string) => () =>
    Promise.all(fileIntegrities.map((fi) => patchAnnotation(fi, key, '')));

  const onFailedOnly = () => {
    setOpen(false);
    setConfirm({
      title: t('Re-initialize every node with detected changes?'),
      body: t(
        'The operator will rebuild the AIDE database on each node currently reporting changes.',
      ),
      run: forEachFi(ANNOTATIONS.reinitOnFailed),
    });
  };

  const onAll = () => {
    setOpen(false);
    setConfirm({
      title: t('Re-initialize every node?'),
      body: t(
        'The operator will rebuild the AIDE database on every node covered by {{count}} FileIntegrity resource(s).',
        { count: fileIntegrities.length },
      ),
      run: forEachFi(ANNOTATIONS.reinit),
    });
  };

  return (
    <>
      <Dropdown
        isOpen={open}
        onOpenChange={setOpen}
        toggle={(ref: React.Ref<MenuToggleElement>) => (
          <MenuToggle ref={ref} onClick={() => setOpen(!open)}>
            {t('Actions')}
          </MenuToggle>
        )}
      >
        <DropdownList>
          <DropdownItem onClick={onFailedOnly}>
            {t('Re-initialize baseline on nodes with changes')}
          </DropdownItem>
          <DropdownItem onClick={onAll}>
            {t('Re-initialize baseline on all nodes')}
          </DropdownItem>
        </DropdownList>
      </Dropdown>
      <ReinitConfirmModal
        state={confirm}
        onClose={() => setConfirm(undefined)}
      />
    </>
  );
};
