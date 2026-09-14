import * as React from 'react';
import { Card, CardBody, useT } from '@wp/ui';

/**
 * MessagePreview (P26b U4) - a read-only chat-bubble preview of the composer
 * body, mirroring the exact text being typed (never a re-summarised or
 * truncated copy). `{token}`-shaped variables are highlighted inline so the
 * sender can see at a glance which parts resolve per-recipient. Purely
 * presentational.
 */
export interface MessagePreviewProps {
  body: string;
}

const TOKEN_PATTERN = /\{\{[a-zA-Z0-9_.]+\}\}/g;

function renderHighlighted(body: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  TOKEN_PATTERN.lastIndex = 0;
  let key = 0;
  while ((match = TOKEN_PATTERN.exec(body)) !== null) {
    if (match.index > lastIndex) {
      parts.push(body.slice(lastIndex, match.index));
    }
    parts.push(
      <span key={`token-${String(key)}`} className="rounded bg-accent-soft px-1 text-accent">
        {match[0]}
      </span>,
    );
    key += 1;
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < body.length) parts.push(body.slice(lastIndex));
  return parts;
}

export function MessagePreview({ body }: MessagePreviewProps): React.JSX.Element {
  const t = useT();
  const now = React.useMemo(() => new Date(), []);
  const timeLabel = React.useMemo(
    () => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(now),
    [now],
  );

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold font-ui text-fg">
          {t('messages.compose.previewTitle')}
        </h2>
        {body.trim().length === 0 ? (
          <p className="text-sm font-ui text-muted">{t('messages.compose.previewEmpty')}</p>
        ) : (
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-lg bg-surface-2 px-3 py-2 text-fg shadow-sm">
              <p className="whitespace-pre-wrap break-words text-sm font-ui">
                {renderHighlighted(body)}
              </p>
              <p className="mt-1 text-right text-[11px] text-muted">{timeLabel}</p>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
