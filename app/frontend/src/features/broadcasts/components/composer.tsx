import * as React from 'react';
import {
  Button,
  Card,
  CardBody,
  DateTimePicker,
  Input,
  RadioGroup,
  Stepper,
  useT,
  type StepperStep,
} from '@wp/ui';
import { extractTemplateTokens } from '@wp/domain';
import { PageHeader } from '../../../components/page-header.js';
import { PreflightPanel } from './preflight-panel.js';
import { AudiencePicker } from './audience-picker.js';
import { VariablePicker } from './variable-picker.js';
import { ComposerInstanceField } from './ComposerInstanceField.js';
import { useComposer } from './use-composer.js';
import { useInstanceOptions } from '../api.js';

/** Maps `useComposer`'s error-kind union to its exact i18n key - no string concatenation/cast. */
const ERROR_MESSAGE_KEYS = {
  validation: 'broadcasts.composer.error.validation',
  limit: 'broadcasts.composer.error.limit',
  noPlan: 'broadcasts.limit.noPlan',
  conflict: 'broadcasts.composer.error.conflict',
  generic: 'broadcasts.composer.error.generic',
} as const;

const PRIORITY_OPTIONS = ['low', 'normal', 'high'] as const;
const PRIORITY_LABEL_KEYS = {
  low: 'broadcasts.composer.priority.low',
  normal: 'broadcasts.composer.priority.normal',
  high: 'broadcasts.composer.priority.high',
} as const;

/** P24 groups-messaging Unit U5: the audience-step "Send to" toggle. */
const TARGET_KIND_OPTIONS = ['contacts', 'groups'] as const;
const TARGET_KIND_LABEL_KEYS = {
  contacts: 'broadcasts.targetKind.contacts',
  groups: 'broadcasts.targetKind.groups',
} as const;

/**
 * Derives the `Stepper`'s decorative `current` index from which fields are
 * already filled - never a gate on field visibility (every field from every
 * step stays mounted, see the `Composer` doc comment above).
 */
function composerStepIndex(
  name: string,
  instanceId: string,
  hasAudience: boolean,
  body: string,
): number {
  if (name.trim().length === 0 || instanceId.trim().length === 0 || !hasAudience) return 0;
  if (body.trim().length === 0) return 1;
  return 2;
}

export interface ComposerProps {
  /** Injectable navigation hook so this component never requires a live router in tests. */
  onStarted?: (id: string) => void;
}

const STEP_IDS = ['audience', 'message', 'schedule', 'review'] as const;

/**
 * Composer (P23a Unit U4; P26b U4 restyle) - the broadcast composer +
 * variables + audience picker, pure render over `useComposer`'s state
 * machine (the `Composer.tsx`/`useComposer.ts` split idiom from
 * `features/messages/compose`). Renders the editing form until a quote
 * exists, then swaps in the existing `PreflightPanel` - never re-implements
 * pre-flight rendering.
 *
 * Every field from every step stays mounted and directly fillable in one
 * pass (composer.test.tsx's `fillBasicForm` and its four sibling suites all
 * depend on this - no click-through gating was introduced). The `Stepper`
 * above the form is a purely presentational progress indicator, derived
 * from which fields are already filled; it is never a gate on which inputs
 * exist in the DOM.
 */
export function Composer({ onStarted }: ComposerProps): React.JSX.Element {
  const t = useT();
  const composer = useComposer({ onStarted });
  const instanceOptions = useInstanceOptions();
  const bodyRef = React.useRef<HTMLTextAreaElement>(null);

  if (
    composer.stage === 'quoted' ||
    composer.stage === 'starting' ||
    composer.stage === 'started'
  ) {
    if (composer.quote) {
      return (
        <PreflightPanel
          quote={composer.quote}
          onStart={composer.start}
          onBack={composer.backToEditing}
          starting={composer.stage === 'starting'}
          errorMessage={composer.errorKey ? t(ERROR_MESSAGE_KEYS[composer.errorKey]) : undefined}
        />
      );
    }
  }

  const insertToken = (token: string): void => {
    const cursorPos = bodyRef.current?.selectionStart ?? composer.body.length;
    composer.insertToken(token, cursorPos);
  };

  const tokensInUse = extractTemplateTokens(composer.body);

  const hasAudience =
    composer.targetKind === 'groups'
      ? true // "all enabled groups" is a valid default - see `AudiencePicker`'s groups checklist.
      : composer.tagIds.length > 0 || composer.contactIds.length > 0;

  const canReview =
    composer.name.trim().length > 0 &&
    composer.instanceId.trim().length > 0 &&
    hasAudience &&
    composer.body.trim().length > 0 &&
    composer.stage !== 'quoting';

  const steps: StepperStep[] = STEP_IDS.map((id) => ({
    id,
    label: t(`broadcasts.wizard.step.${id}`),
  }));
  const currentStepIndex = composerStepIndex(
    composer.name,
    composer.instanceId,
    hasAudience,
    composer.body,
  );

  return (
    <div data-testid="broadcast-composer" className="flex flex-col gap-6">
      <PageHeader title={t('broadcasts.composer.title')} />

      <Stepper
        steps={steps}
        current={currentStepIndex}
        orientation="horizontal"
        completedLabel={t('broadcasts.wizard.stepDone')}
        currentLabel={t('broadcasts.wizard.stepCurrent')}
        upcomingLabel={t('broadcasts.wizard.stepUpcoming')}
      />

      {composer.errorKey ? (
        <p role="alert" className="text-sm font-ui text-danger">
          {t(ERROR_MESSAGE_KEYS[composer.errorKey])}
        </p>
      ) : null}

      <Card>
        <CardBody className="flex flex-col gap-4">
          <Input
            label={t('broadcasts.composer.nameLabel')}
            value={composer.name}
            onChange={(event) => composer.setName(event.target.value)}
          />

          <ComposerInstanceField
            label={t('broadcasts.composer.instanceLabel')}
            instances={instanceOptions.data}
            value={composer.instanceId}
            onValueChange={composer.setInstanceId}
            t={t}
          />

          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium font-ui text-fg">
              {t('broadcasts.targetKind.label')}
            </span>
            <div
              role="radiogroup"
              aria-label={t('broadcasts.targetKind.label')}
              className="flex gap-2"
            >
              {TARGET_KIND_OPTIONS.map((option) => (
                <label
                  key={option}
                  className="flex items-center gap-1 text-sm font-ui text-fg"
                  data-testid={`composer-target-kind-${option}`}
                >
                  <input
                    type="radio"
                    name="composer-target-kind"
                    checked={composer.targetKind === option}
                    onChange={() => composer.setTargetKind(option)}
                  />
                  {t(TARGET_KIND_LABEL_KEYS[option])}
                </label>
              ))}
            </div>
          </div>

          <AudiencePicker
            targetKind={composer.targetKind}
            instanceId={composer.instanceId}
            tagIds={composer.tagIds}
            contactIds={composer.contactIds}
            contactLabels={composer.contactLabels}
            onToggleTag={composer.toggleTag}
            onAddContact={composer.addContact}
            onRemoveContact={composer.removeContact}
            groupIds={composer.groupIds}
            onToggleGroup={composer.toggleGroup}
          />
        </CardBody>
      </Card>

      <Card>
        <CardBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="composer-body-field" className="text-sm font-medium font-ui text-fg">
              {t('broadcasts.composer.bodyLabel')}
            </label>
            <textarea
              id="composer-body-field"
              ref={bodyRef}
              data-testid="composer-body"
              value={composer.body}
              onChange={(event) => composer.setBody(event.target.value)}
              className="min-h-24 rounded-md border border-border bg-surface px-3 py-2 text-sm font-ui text-fg"
            />
            {tokensInUse.length > 0 ? (
              <p className="text-sm font-ui text-muted">
                {t('broadcasts.composer.tokensInUse', { tokens: tokensInUse.join(', ') })}
              </p>
            ) : null}
          </div>

          <VariablePicker onInsert={insertToken} />
        </CardBody>
      </Card>

      <Card>
        <CardBody className="flex flex-col gap-4" data-testid="composer-priority">
          <RadioGroup
            label={t('broadcasts.composer.priorityLabel')}
            orientation="horizontal"
            options={PRIORITY_OPTIONS.map((option) => ({
              value: option,
              label: t(PRIORITY_LABEL_KEYS[option]),
            }))}
            value={composer.priority}
            onValueChange={(value) => composer.setPriority(value as 'high' | 'normal' | 'low')}
          />
          <p className="text-sm font-ui text-muted">{t('broadcasts.composer.priorityNote')}</p>

          <div data-testid="composer-schedule">
            <DateTimePicker
              label={t('broadcasts.composer.scheduleLabel')}
              description={t('broadcasts.composer.scheduleHelp')}
              timezoneLabel={t('broadcasts.wizard.timezoneLabel')}
              value={composer.scheduledAt}
              onValueChange={(iso) => composer.setScheduledAtLocal(iso ?? '')}
            />
          </div>
        </CardBody>
      </Card>

      <p data-testid="broadcast-disclosure">{t('broadcasts.disclosure')}</p>

      <Button
        type="button"
        data-testid="composer-review"
        disabled={!canReview}
        loading={composer.stage === 'quoting'}
        loadingLabel={t('broadcasts.composer.quoting')}
        onClick={composer.requestQuote}
      >
        {t('broadcasts.composer.reviewQuote')}
      </Button>
    </div>
  );
}
