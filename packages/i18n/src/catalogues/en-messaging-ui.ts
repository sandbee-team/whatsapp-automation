import type { Catalogue } from './catalogue-type.js';

/**
 * English strings for the P26b U4 messages, unresolved and fan-out screens
 * (filled by that unit only; hi-messaging-ui.ts mirrors every key). Existing
 * `messages.*`/`unresolved.*`/`broadcasts.*` keys already live in `en.ts`/
 * `en-broadcasts.ts` and are reused verbatim; this file only adds the NEW
 * strings the restyled surfaces need (number picker, unresolved explainer
 * card, wizard steps).
 */
export const enMessagingUi = {
  'messages.compose.accountPicker.label': 'From number',
  'messages.compose.accountPicker.placeholder': 'Choose a connected number',
  'messages.compose.accountPicker.disabledHint': 'Not ready to send',
  'messages.compose.accountPicker.empty': 'No connected numbers yet.',
  'messages.compose.previewTitle': 'Preview',
  'messages.compose.previewEmpty': 'Your message preview appears here as you type.',
  'messages.compose.recipientPicker.searchLabel': 'Search contacts',
  'messages.compose.charCount': '{count}/{max}',

  'messages.compose.captionLabel': 'Caption (optional)',
  'messages.compose.attachment.label': 'Attachment (optional)',
  'messages.compose.attachment.hint': 'Attach one image or document.',
  'messages.compose.attachment.caps': 'Images up to {imageMb} MB, documents up to {documentMb} MB.',
  'messages.compose.attachment.uploading': 'Uploading attachment',
  'messages.compose.attachment.remove': 'Remove attachment',
  'messages.compose.attachment.errorTooLarge':
    'That file is too large. Choose a smaller image or document.',
  'messages.compose.attachment.errorUnsupportedType':
    'That file type is not supported. Choose an image or a document in a supported format.',
  'messages.compose.attachment.errorUploadFailed':
    'The attachment could not be uploaded. Please try again.',
  'messages.compose.attachment.errorUploadInProgress':
    "You can't send yet - the attachment is still uploading.",

  'unresolved.explainer.title': 'Where unresolved sends come from',
  'unresolved.explainer.body':
    'A send lands here when we could not confirm whether WhatsApp actually delivered it - for ' +
    'example after a reconnect. Look up the number below to review and act on its unresolved ' +
    'sends; you can also see related notifications on the dashboard activity feed.',
  'unresolved.explainer.dashboardLink': 'Go to dashboard activity',
  'unresolved.unavailable.title': 'Nothing to show yet',
  'unresolved.unavailable.body':
    'Enter a number above to check its unresolved sends. This view lists only sends we could ' +
    'not confirm - it is never a general message history.',
  'unresolved.accountPicker.label': 'Number',
  'unresolved.accountPicker.placeholder': 'Instance id',
  'unresolved.toast.retrySuccess': 'Retry queued.',
  'unresolved.toast.discardSuccess': 'Send discarded.',
  'unresolved.toast.actionError': 'Something went wrong. Please try again.',

  'broadcasts.wizard.step.audience': 'Audience',
  'broadcasts.wizard.step.message': 'Message',
  'broadcasts.wizard.step.schedule': 'Schedule',
  'broadcasts.wizard.step.review': 'Review & preflight',
  'broadcasts.wizard.stepDone': 'Done',
  'broadcasts.wizard.stepCurrent': 'Current step',
  'broadcasts.wizard.stepUpcoming': 'Not started',
  'broadcasts.wizard.next': 'Next',
  'broadcasts.wizard.back': 'Back',
  'broadcasts.wizard.timezoneLabel': 'Times shown in your device timezone',

  'broadcasts.list.actions.label': 'Actions',
  'broadcasts.list.actions.open': 'Open',
  'broadcasts.list.actions.pause': 'Pause',
  'broadcasts.list.actions.resume': 'Resume',
  'broadcasts.list.actions.cancel': 'Cancel',
  'broadcasts.list.col.actions': 'Actions',
  'broadcasts.list.toast.pauseSuccess': 'Sending paused.',
  'broadcasts.list.toast.resumeSuccess': 'Sending resumed.',
  'broadcasts.list.toast.cancelSuccess': 'Sending cancelled.',
  'broadcasts.list.toast.actionError': 'Something went wrong. The broadcast was not changed.',

  // P26b C1 fix round MINOR-10: mark-all-read had no failure toast at all
  // (unlike the single mark-read action, which already had one).
  'notifications.bell.markAllReadError': 'Could not mark all as read. Please try again.',
} as const satisfies Catalogue;
