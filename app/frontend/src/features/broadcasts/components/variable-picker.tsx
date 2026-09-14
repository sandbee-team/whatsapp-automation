import * as React from 'react';
import { Button, useT } from '@wp/ui';

/**
 * VariablePicker (P23a Unit U4) - buttons for the four flat template tokens
 * plus a validated `attrs.<key>` text input. The key regex mirrors the exact
 * vocabulary the snapshot resolves (`^[a-z][a-z0-9_]{0,31}$` -
 * `app/backend/src/modules/broadcasts/snapshot-vars.ts`, read not imported);
 * an invalid key never calls `onInsert` and surfaces a `role="alert"`
 * instead, so a token that can never resolve can never be typed in.
 */

const FLAT_TOKENS = ['first_name', 'last_name', 'display_name', 'phone_e164'] as const;

const ATTR_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

export interface VariablePickerProps {
  onInsert: (token: string) => void;
}

export function VariablePicker({ onInsert }: VariablePickerProps): React.JSX.Element {
  const t = useT();
  const [attrKey, setAttrKey] = React.useState('');
  const [invalid, setInvalid] = React.useState(false);

  const insertAttr = (): void => {
    if (!ATTR_KEY_PATTERN.test(attrKey)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onInsert(`attrs.${attrKey}`);
    setAttrKey('');
  };

  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-medium font-ui text-fg">
        {t('broadcasts.composer.variablesLabel')}
      </h4>
      <div className="flex flex-wrap gap-2">
        {FLAT_TOKENS.map((token) => (
          <Button
            key={token}
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onInsert(token)}
          >
            {token}
          </Button>
        ))}
      </div>
      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="variable-attr-key" className="text-sm font-medium font-ui text-fg">
            {t('broadcasts.composer.attrKeyPlaceholder')}
          </label>
          <input
            id="variable-attr-key"
            data-testid="variable-attr-key"
            placeholder={t('broadcasts.composer.attrKeyPlaceholder')}
            value={attrKey}
            onChange={(event) => {
              setAttrKey(event.target.value);
              setInvalid(false);
            }}
            className="h-10 rounded-md border border-border bg-surface px-3 text-sm font-ui text-fg"
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-testid="variable-attr-insert"
          onClick={insertAttr}
        >
          {t('broadcasts.composer.insert')}
        </Button>
      </div>
      {invalid ? (
        <p role="alert" className="text-sm font-ui text-danger">
          {t('broadcasts.composer.attrKeyInvalid')}
        </p>
      ) : null}
      <p className="text-sm font-ui text-muted">{t('broadcasts.composer.variablesHelp')}</p>
    </div>
  );
}
