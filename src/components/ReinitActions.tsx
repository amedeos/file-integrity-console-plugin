import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { MenuToggleElement } from '@patternfly/react-core';
import {
  Alert,
  Button,
  Content,
  Dropdown,
  DropdownItem,
  DropdownList,
  MenuToggle,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
} from '@patternfly/react-core';
import { k8sPatch } from '@openshift-console/dynamic-plugin-sdk';
import { ANNOTATIONS, I18N_NS } from '../constants';
import { FileIntegrityModel } from '../models';
import type { FileIntegrity } from '../types';
import { addNodeToReinit, setAnnotationPatch } from '../lib/reinit';
import { errorMessage } from '../lib/errors';

interface ConfirmState {
  title: string;
  body: React.ReactNode;
  run: () => Promise<unknown>;
}

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

  // Reset when the modal is opened for a different action. Done during render
  // rather than in an effect so the previous attempt's error cannot flash under
  // the new confirmation text.
  const [stateShown, setStateShown] = React.useState(state);
  if (state !== stateShown) {
    setStateShown(state);
    setError(undefined);
    setSubmitting(false);
  }

  if (!state) {
    return null;
  }

  const confirm = async () => {
    setSubmitting(true);
    setError(undefined);
    try {
      await state.run();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setSubmitting(false);
    }
  };

  // onClick expects a void return. Handing it an async function makes the
  // rejection nobody awaits into an unhandled one; confirm() already handles
  // its own failures, so discarding the promise is the honest thing to say.
  const onConfirm = () => {
    void confirm();
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

  const onClick = () => {
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
  };

  return (
    <>
      <Button variant="secondary" onClick={onClick}>
        {t('Re-initialize baseline')}
      </Button>
      <ReinitConfirmModal
        state={confirm}
        onClose={() => {
          setConfirm(undefined);
        }}
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
        // The toggle sits at the right edge of the page header, and the menu
        // defaults to position "start": it anchors to the toggle's left edge
        // and grows rightwards, off the viewport, taking these long labels with
        // it. "end" is the logical form of right-aligned, so it keeps working
        // in a right-to-left locale; preventOverflow is what PatternFly's own
        // API notes recommend when a menu still gets clipped.
        popperProps={{ position: 'end', preventOverflow: true }}
        toggle={(ref: React.Ref<MenuToggleElement>) => (
          <MenuToggle
            ref={ref}
            onClick={() => {
              setOpen(!open);
            }}
          >
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
        onClose={() => {
          setConfirm(undefined);
        }}
      />
    </>
  );
};
