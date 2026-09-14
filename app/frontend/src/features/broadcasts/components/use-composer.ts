import * as React from 'react';
import { createBroadcastInputSchema } from '@wp/contracts';
import type { BroadcastPreflight } from '../api.js';
import { createBroadcast, preflightBroadcast, startBroadcast, cancelBroadcast } from '../api.js';
import { ApiError } from '../../../lib/api-client.js';

/**
 * useComposer (P23a Unit U4; P23a C1 fix round MINOR 6) - the composer's
 * state machine, split out of `composer.tsx` for a pure render layer (the
 * `useComposer`/`Composer.tsx` idiom in `features/messages/compose`). A
 * draft broadcast is a real server resource from the first "Review quote"
 * click onward: `requestQuote` creates it, then pre-flights it;
 * `backToEditing` CANCELS that draft rather than abandoning it (core
 * invariant: no orphaned resources), keeping every field value so the user
 * can adjust and re-review. `start` mints a SEPARATE, fresh idempotency key
 * from the one used to create the draft.
 *
 * Idempotency keys belong to the INTENT, not the attempt: `createKeyRef`/
 * `startKeyRef` are minted once (on the first Review/Start click of a given
 * intent) and REUSED on every retry of that same intent, so a 503 followed
 * by a user-driven retry never risks a duplicate draft/start server-side.
 * A key is only cleared - so the NEXT click mints a fresh one - on the
 * outcomes that end the intent: a successful create/start, or
 * `backToEditing`'s cancel. A pre-flight failure AFTER a successful create
 * also ends that intent: the draft `requestQuote` just created is no longer
 * useful (its quote never arrived), so it is best-effort cancelled here -
 * the same "no orphaned resources" contract `backToEditing` already
 * upholds - and `draftId`/`quote`/`createKeyRef` are all cleared so the next
 * Review click starts a genuinely new intent with a new key.
 */

export type ComposerStage = 'editing' | 'quoting' | 'quoted' | 'starting' | 'started';
export type ComposerErrorKind = 'validation' | 'limit' | 'noPlan' | 'conflict' | 'generic';
/** P24 groups-messaging Unit U5: the audience-step "Send to" toggle - never sent to the server itself, only DERIVES which `audience.kind` is built (see `requestQuote`'s doc comment). */
export type ComposerTargetKind = 'contacts' | 'groups';

export interface ComposerState {
  name: string;
  instanceId: string;
  targetKind: ComposerTargetKind;
  tagIds: string[];
  contactIds: string[];
  contactLabels: Record<string, string>;
  groupIds: string[];
  body: string;
  priority: 'high' | 'normal' | 'low';
  scheduledAt: string | null;
  stage: ComposerStage;
  draftId: string | null;
  quote: BroadcastPreflight | null;
  errorKey: ComposerErrorKind | null;
  setName: (value: string) => void;
  setInstanceId: (value: string) => void;
  setTargetKind: (value: ComposerTargetKind) => void;
  toggleTag: (tagId: string) => void;
  addContact: (contactId: string, label: string) => void;
  removeContact: (contactId: string) => void;
  toggleGroup: (groupId: string) => void;
  setBody: (value: string) => void;
  setPriority: (value: 'high' | 'normal' | 'low') => void;
  setScheduledAtLocal: (localValue: string) => void;
  insertToken: (token: string, cursorPos: number) => void;
  requestQuote: () => void;
  backToEditing: () => void;
  start: () => void;
}

export interface UseComposerOptions {
  onStarted?: (id: string) => void;
}

function errorKeyFor(error: unknown): ComposerErrorKind {
  if (error instanceof ApiError) {
    if (error.code === 'CONFLICT') return 'conflict';
    if (error.code === 'CONTACT_LIMIT_REACHED') return 'limit';
    // P23a C1 fix round: a workspace with no plan attached (402 ENTITLEMENT_ERROR from the pre-flight) - the catalogue's honest no-plan line, never the generic one.
    if (error.code === 'ENTITLEMENT_ERROR') return 'noPlan';
  }
  return 'generic';
}

export function useComposer(options: UseComposerOptions = {}): ComposerState {
  const [name, setName] = React.useState('');
  const [instanceId, setInstanceId] = React.useState('');
  const [targetKind, setTargetKind] = React.useState<ComposerTargetKind>('contacts');
  const [tagIds, setTagIds] = React.useState<string[]>([]);
  const [contactIds, setContactIds] = React.useState<string[]>([]);
  const [contactLabels, setContactLabels] = React.useState<Record<string, string>>({});
  const [groupIds, setGroupIds] = React.useState<string[]>([]);
  const [body, setBody] = React.useState('');
  const [priority, setPriority] = React.useState<'high' | 'normal' | 'low'>('low');
  const [scheduledAt, setScheduledAt] = React.useState<string | null>(null);
  const [stage, setStage] = React.useState<ComposerStage>('editing');
  const [draftId, setDraftId] = React.useState<string | null>(null);
  const [quote, setQuote] = React.useState<BroadcastPreflight | null>(null);
  const [errorKey, setErrorKey] = React.useState<ComposerErrorKind | null>(null);

  const bodyRef = React.useRef(body);
  bodyRef.current = body;

  // One idempotency key per INTENT (see this file's header) - held here
  // rather than in state because minting/clearing them is never itself
  // something a render needs to react to.
  const createKeyRef = React.useRef<string | null>(null);
  const startKeyRef = React.useRef<string | null>(null);

  const toggleTag = React.useCallback((tagId: string): void => {
    setTagIds((current) =>
      current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId],
    );
  }, []);

  const addContact = React.useCallback((contactId: string, label: string): void => {
    setContactIds((current) => (current.includes(contactId) ? current : [...current, contactId]));
    setContactLabels((current) => ({ ...current, [contactId]: label }));
  }, []);

  const toggleGroup = React.useCallback((groupId: string): void => {
    setGroupIds((current) =>
      current.includes(groupId) ? current.filter((id) => id !== groupId) : [...current, groupId],
    );
  }, []);

  const removeContact = React.useCallback((contactId: string): void => {
    setContactIds((current) => current.filter((id) => id !== contactId));
  }, []);

  const setScheduledAtLocal = React.useCallback((localValue: string): void => {
    if (!localValue) {
      setScheduledAt(null);
      return;
    }
    setScheduledAt(new Date(localValue).toISOString());
  }, []);

  const insertToken = React.useCallback((token: string, cursorPos: number): void => {
    const current = bodyRef.current;
    const insertion = `{{${token}}}`;
    const pos = Math.max(0, Math.min(cursorPos, current.length));
    setBody(`${current.slice(0, pos)}${insertion}${current.slice(pos)}`);
  }, []);

  const requestQuote = React.useCallback((): void => {
    // P24 groups-messaging Unit U5: `audience.kind` is DERIVED from the
    // "Send to" toggle - never a separate `targetKind` wire field (the
    // server infers target kind from the audience shape alone, see
    // `@wp/contracts`'s `broadcastAudienceSchema` doc comment).
    const audience =
      targetKind === 'groups'
        ? { kind: 'groups' as const, groupIds: groupIds.length > 0 ? groupIds : undefined }
        : {
            kind: 'contacts' as const,
            tagIds: tagIds.length > 0 ? tagIds : undefined,
            contactIds: contactIds.length > 0 ? contactIds : undefined,
          };

    const input = {
      name,
      instanceId,
      audience,
      message: { kind: 'text' as const, body },
      priority,
      scheduledAt,
    };

    const parsed = createBroadcastInputSchema.safeParse(input);
    if (!parsed.success) {
      setErrorKey('validation');
      return;
    }

    setStage('quoting');
    setErrorKey(null);
    // One key per intent: minted on the FIRST Review click of this intent,
    // reused on every retry (a fresh key is only minted once the previous
    // intent has ended - see this file's header).
    createKeyRef.current ??= crypto.randomUUID();
    const createKey = createKeyRef.current;

    createBroadcast(parsed.data, createKey)
      .then((draft) => {
        setDraftId(draft.id);
        return preflightBroadcast(draft.id).catch((preflightError: unknown) => {
          // The draft this attempt just created is no longer useful (its
          // quote never arrived) - cancel it best-effort so it is never
          // orphaned, exactly like `backToEditing`, then end this intent so
          // the next Review click mints a genuinely new create key.
          const cancelKey = crypto.randomUUID();
          void cancelBroadcast(draft.id, cancelKey, 'preflight_failed').catch(() => {
            // Best-effort: nothing more to do client-side if the cancel
            // itself failed to apply.
          });
          createKeyRef.current = null;
          setDraftId(null);
          setQuote(null);
          throw preflightError;
        });
      })
      .then((preflight) => {
        setQuote(preflight);
        setStage('quoted');
        createKeyRef.current = null;
      })
      .catch((error: unknown) => {
        // A create that failed outright keeps createKeyRef for the next
        // retry (same intent, same key); the preflight-failure branch above
        // already cleared it for that separate case.
        setStage('editing');
        setErrorKey(errorKeyFor(error));
      });
  }, [name, instanceId, targetKind, tagIds, contactIds, groupIds, body, priority, scheduledAt]);

  const backToEditing = React.useCallback((): void => {
    const id = draftId;
    if (!id) {
      setStage('editing');
      createKeyRef.current = null;
      return;
    }
    const cancelKey = crypto.randomUUID();
    void cancelBroadcast(id, cancelKey, 'edited_before_start').catch(() => {
      // Best-effort: the draft is abandoned client-side regardless so the
      // user is never stuck unable to edit; the server-side draft is
      // harmless if the cancel itself failed to apply.
    });
    setDraftId(null);
    setQuote(null);
    setStage('editing');
    createKeyRef.current = null;
  }, [draftId]);

  const start = React.useCallback((): void => {
    const id = draftId;
    if (!id) return;
    setStage('starting');
    setErrorKey(null);
    startKeyRef.current ??= crypto.randomUUID();
    const startKey = startKeyRef.current;

    void startBroadcast(id, startKey)
      .then(() => {
        setStage('started');
        startKeyRef.current = null;
        options.onStarted?.(id);
      })
      .catch((error: unknown) => {
        setStage('quoted');
        setErrorKey(errorKeyFor(error));
      });
  }, [draftId, options]);

  return {
    name,
    instanceId,
    targetKind,
    tagIds,
    contactIds,
    contactLabels,
    groupIds,
    body,
    priority,
    scheduledAt,
    stage,
    draftId,
    quote,
    errorKey,
    setName,
    setInstanceId,
    setTargetKind,
    toggleTag,
    addContact,
    removeContact,
    toggleGroup,
    setBody,
    setPriority,
    setScheduledAtLocal,
    insertToken,
    requestQuote,
    backToEditing,
    start,
  };
}
