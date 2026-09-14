'use client';

import * as React from 'react';
import { Button } from '@wp/ui';
import { Input } from '@wp/ui';
import { CONTACT_COPY } from '../content/copy/contact.js';
import { readUtm, submitLead } from '../lib/leads.js';
import { trackEvent } from '../lib/analytics.js';

/**
 * lead-form.tsx (P29 U4b) - the marketing contact form. Two anti-bot
 * fields ride along with the visible ones and are never shown to a
 * sighted user:
 *
 *  - a honeypot text input (`website`), visually hidden and marked
 *    `aria-hidden`/`tabIndex -1`/`autoComplete off` so neither a sighted
 *    visitor nor a screen reader ever encounters it, but a naive bot that
 *    fills every field still fills it in;
 *  - `startedAt`, captured on mount (`useEffect`, not render time) so the
 *    server's minimum-elapsed-time check reflects when the form actually
 *    became interactive.
 *
 * Every user-facing string comes from `CONTACT_COPY` - this component never
 * hand-rolls copy.
 */

type SubmitState = 'idle' | 'submitting' | 'success' | 'error' | 'rate_limited';

export interface LeadFormProps {
  source?: string;
}

export function LeadForm({ source = 'contact' }: LeadFormProps): React.JSX.Element {
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [company, setCompany] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [honeypot, setHoneypot] = React.useState('');
  const [state, setState] = React.useState<SubmitState>('idle');
  const startedAtRef = React.useRef(0);

  React.useEffect(() => {
    startedAtRef.current = Date.now();
  }, []);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setState('submitting');
    try {
      const result = await submitLead({
        name,
        email,
        company: company || undefined,
        phoneE164: phone || undefined,
        message,
        source,
        utm: readUtm(window.location.search),
        website: honeypot,
        startedAt: startedAtRef.current,
      });
      if (result.status === 202) {
        setState('success');
        trackEvent('lead_submitted');
      } else if (result.status === 429) {
        setState('rate_limited');
      } else {
        setState('error');
      }
    } catch {
      setState('error');
    }
  };

  const { fields } = CONTACT_COPY;

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="mt-6 max-w-md space-y-4">
      <Input
        label={fields.name.label}
        placeholder={fields.name.placeholder}
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
        maxLength={120}
      />
      <Input
        label={fields.email.label}
        placeholder={fields.email.placeholder}
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        required
        maxLength={254}
      />
      <Input
        label={fields.company.label}
        placeholder={fields.company.placeholder}
        value={company}
        onChange={(event) => setCompany(event.target.value)}
        maxLength={120}
      />
      <Input
        label={fields.phone.label}
        placeholder={fields.phone.placeholder}
        value={phone}
        onChange={(event) => setPhone(event.target.value)}
        maxLength={20}
      />
      <div className="flex flex-col gap-1">
        <label htmlFor="lead-message" className="text-sm font-medium font-ui text-fg">
          {fields.message.label}
        </label>
        <textarea
          id="lead-message"
          placeholder={fields.message.placeholder}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          required
          maxLength={2000}
          rows={5}
          className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 font-ui text-fg placeholder:text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-bg"
        />
      </div>
      {/* Honeypot - hidden from every sighted/assistive-tech visitor. */}
      <div
        aria-hidden="true"
        className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden"
      >
        <label htmlFor="lead-website">Website</label>
        <input
          id="lead-website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={honeypot}
          onChange={(event) => setHoneypot(event.target.value)}
        />
      </div>
      <Button type="submit" disabled={state === 'submitting'}>
        {state === 'submitting' ? CONTACT_COPY.submittingLabel : CONTACT_COPY.submitLabel}
      </Button>
      {state === 'success' ? <p className="text-sm text-fg">{CONTACT_COPY.success}</p> : null}
      {state === 'error' ? <p className="text-sm text-danger">{CONTACT_COPY.error}</p> : null}
      {state === 'rate_limited' ? (
        <p className="text-sm text-danger">{CONTACT_COPY.rateLimited}</p>
      ) : null}
    </form>
  );
}
