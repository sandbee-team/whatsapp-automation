import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Alert, Button, Input, useT } from '@wp/ui';
import { PARKED_BUFFER_CAVEAT, PARKED_COPY } from '@wp/domain';
import { QrPanel } from './QrPanel.js';
import { PairingCodePanel } from './PairingCodePanel.js';
import type { ConnectFlow } from './useConnectFlow.js';

/**
 * ConnectSheetBody (P08 U7) - the stage-conditional render tree, split out
 * of `ConnectSheet.tsx` (workspace 300-line max-lines rule). Pure render:
 * every handler is already bound in the `ConnectFlow` passed down from
 * `useConnectFlow`, so this component owns no state of its own.
 */
export function ConnectSheetBody({ flow }: { flow: ConnectFlow }): React.JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const { stage } = flow;

  return (
    <div data-testid="connect-sheet" className="flex flex-col gap-4">
      {flow.connectError?.kind === 'limitOrNoPlan' ? (
        <Alert
          tone="warning"
          data-testid="connect-limit-or-no-plan"
          title={t(flow.connectError.titleKey)}
          body={`${t(flow.connectError.bodyKey)} ${t(flow.connectError.helpKey)}`}
        />
      ) : flow.errorMessage ? (
        <p role="alert" data-testid="connect-error" className="text-sm font-ui text-danger">
          {flow.errorMessage}
        </p>
      ) : null}

      {stage.name === 'mfa' ? (
        <Alert
          tone="info"
          data-testid="connect-mfa-required"
          title={
            stage.reason === 'enrol'
              ? t('instances.connect.mfaEnrol.body')
              : t('instances.connect.mfaVerify.body')
          }
          action={
            stage.reason === 'enrol' ? (
              <Button
                type="button"
                size="sm"
                data-testid="connect-mfa-setup-button"
                onClick={() => void navigate({ to: '/totp' })}
              >
                {t('instances.connect.mfaEnrol.button')}
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                data-testid="connect-mfa-signin-button"
                onClick={flow.signInAgain}
              >
                {t('instances.connect.mfaVerify.button')}
              </Button>
            )
          }
        />
      ) : null}

      {stage.name === 'create' ? (
        <div className="flex flex-col gap-3">
          <Input
            label={t('instances.connect.labelInput')}
            description={t('instances.connect.labelInput.description')}
            placeholder={t('instances.connect.labelInput.placeholder')}
            data-testid="connect-label-input"
            value={flow.label}
            onChange={(event) => flow.setLabel(event.target.value)}
          />
          <Button
            type="button"
            data-testid="connect-create-button"
            disabled={flow.label.trim().length === 0}
            loading={flow.isSubmitting}
            loadingLabel={t('common.loading')}
            onClick={flow.onCreate}
          >
            {t('instances.connect.createButton')}
          </Button>
        </div>
      ) : null}

      {stage.name === 'method' ? (
        <div className="flex flex-col gap-3">
          <h3 className="text-base font-semibold font-ui text-fg">
            {t('instances.connect.methodTitle')}
          </h3>
          <Button
            type="button"
            variant="secondary"
            data-testid="connect-method-qr"
            onClick={() => flow.onChooseQr(stage.instanceId)}
          >
            {t('instances.connect.methodQr')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            data-testid="connect-method-code"
            onClick={() => flow.onChooseCode(stage.instanceId)}
          >
            {t('instances.connect.methodCode')}
          </Button>
        </div>
      ) : null}

      {stage.name === 'phone' ? (
        <form
          data-testid="connect-phone-form"
          noValidate
          onSubmit={(event) => flow.onSubmitPhone(event)}
          className="flex flex-col gap-3"
        >
          <Input
            label={t('instances.connect.phoneInput')}
            description={t('instances.connect.phoneInput.description')}
            data-testid="connect-phone-input"
            error={flow.phoneForm.formState.errors.phone?.message}
            {...flow.phoneForm.register('phone')}
          />
          <Button type="submit" data-testid="connect-phone-submit" loading={flow.isSubmitting}>
            {t('instances.connect.startButton')}
          </Button>
        </form>
      ) : null}

      {stage.name === 'challenge' && stage.method === 'qr' ? (
        <QrPanel
          payload={flow.linkStream.payload}
          expiresAt={flow.linkStream.expiresAt}
          attemptsLeft={flow.linkStream.attemptsLeft}
          onRefresh={flow.onRefresh}
          isRefreshing={flow.isSubmitting}
        />
      ) : null}

      {stage.name === 'challenge' && stage.method === 'code' ? (
        <PairingCodePanel
          payload={flow.linkStream.payload}
          expiresAt={flow.linkStream.expiresAt}
          attemptsLeft={flow.linkStream.attemptsLeft}
          onRefresh={flow.onRefresh}
          isRefreshing={flow.isSubmitting}
        />
      ) : null}

      {stage.name === 'challenge' ? (
        <Button
          type="button"
          variant="secondary"
          data-testid="connect-go-online-button"
          loading={flow.isSubmitting}
          onClick={() => flow.goOnline(stage.instanceId)}
        >
          {t('instances.connect.parked.onlineButton')}
        </Button>
      ) : null}

      {stage.name === 'linking' ? (
        // 2026-09-15 bug fix: `goOnline` no longer jumps straight to
        // 'connected' on the `/online` 200 (that call only sets
        // `desired_state` - see `useConnectFlow.ts#goOnline`'s comment). This
        // is the honest "still pairing" waiting state shown until
        // `linkStream.healthState` actually reports 'connected'.
        <div data-testid="connect-linking-state" className="flex flex-col gap-2">
          <h3 className="text-base font-semibold font-ui text-fg">
            {t('instances.connect.linking.title')}
          </h3>
          <p className="text-sm font-ui text-muted">{t('instances.connect.linking.body')}</p>
        </div>
      ) : null}

      {stage.name === 'connected' ? (
        <div data-testid="connect-connected-state" className="flex flex-col gap-2">
          <h3 className="text-base font-semibold font-ui text-success">
            {t('instances.connect.connected.title')}
          </h3>
          <p className="text-sm font-ui text-fg">{t('instances.connect.connected.body')}</p>
          {stage.maskedNumber ? (
            <p data-testid="connect-masked-number" className="font-mono text-sm text-fg">
              {stage.maskedNumber}
            </p>
          ) : null}
        </div>
      ) : null}

      {stage.name === 'parked' ? (
        <div data-testid="connect-parked-state" className="flex flex-col gap-2">
          <h3 className="text-base font-semibold font-ui text-fg">
            {t('instances.connect.parked.title')}
          </h3>
          <p data-testid="connect-parked-copy" className="text-sm font-ui text-fg">
            {PARKED_COPY}
          </p>
          <p data-testid="connect-parked-buffer-caveat" className="text-sm font-ui text-muted">
            {PARKED_BUFFER_CAVEAT}
          </p>
        </div>
      ) : null}

      {stage.name === 'noFreeSlot' ? (
        <div data-testid="connect-no-free-slot" className="flex flex-col gap-3">
          <h3 className="text-base font-semibold font-ui text-fg">
            {t('instances.connect.noFreeSlot.title')}
          </h3>
          <p className="text-sm font-ui text-muted">{t('instances.connect.noFreeSlot.body')}</p>
          <ul className="flex flex-col gap-2">
            {stage.holders.map((holder) => (
              <li
                key={holder.instanceId}
                data-testid={`no-free-slot-holder-${holder.instanceId}`}
                className="flex items-center justify-between gap-3 rounded-md border border-border p-2"
              >
                <span className="text-sm font-ui text-fg">
                  {holder.label ?? ''} {holder.maskedNumber ?? ''}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  data-testid={`park-instead-button-${holder.instanceId}`}
                  loading={flow.isSubmitting}
                  onClick={() =>
                    flow.parkHolderThenRetryOnline(stage.instanceId, holder.instanceId)
                  }
                >
                  {t('instances.connect.noFreeSlot.parkInsteadButton')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {stage.name === 'connected' ||
      stage.name === 'parked' ||
      stage.name === 'challenge' ||
      stage.name === 'linking' ? (
        flow.activeInstanceId ? (
          <Button
            type="button"
            variant="ghost"
            data-testid="connect-park-button"
            loading={flow.isSubmitting}
            onClick={() => flow.goPark(flow.activeInstanceId as string)}
          >
            {t('instances.connect.parked.parkButton')}
          </Button>
        ) : null
      ) : null}
    </div>
  );
}
