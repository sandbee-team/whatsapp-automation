/**
 * features.ts (P29 U2) - copy for the /features/ page. Honest feature
 * bullets only: no capacity number, no price, no delivery-speed promise, no
 * comparison against WhatsApp's own limits (safety-compliance). Priority
 * levels order work, not a speed promise.
 */

// byte-identical mirror of @wp/domain's SAFE_MODE_DISCLAIMER - check-copy
// matches file text; the drift test in website/tests/legal.test.ts pins it
const SAFE_MODE_DISCLAIMER_LITERAL = `Safe Mode paces your sending and watches your account's real signals. It reduces the risk of triggering spam or rate-limit signals from sending too fast or too cold. It cannot prevent or guarantee against WhatsApp restrictions — bans also come from recipient reports, message content and account reputation, which no sender-side pacing can control.`;

// byte-identical mirror of @wp/domain's BROADCAST_DISCLOSURE - check-copy
// matches file text; the drift test in website/tests/legal.test.ts pins it
const BROADCAST_DISCLOSURE_LITERAL = `What "Broadcast" means in WP. WhatsApp's own broadcast lists have a limitation most people discover the hard way: a broadcast-list message is only delivered to recipients who have already saved your number in their phone. Everyone else silently receives nothing. WP does not use broadcast lists. When you send a WP Broadcast, we create one individually-addressed message per recipient — the same thing as if you had opened each chat and typed it yourself — and we send them one at a time, paced, from your connected number. That is why a broadcast to 2,000 people takes hours or days rather than seconds: the pacing is the product. It also means each recipient sees a normal one-to-one message from you, can reply to it, and their reply lands in your Inbox. A Broadcast is not a licence to exceed your account's daily cap — it simply takes as long as your cap allows, and the panel shows you the honest estimated finish time before you start.`;

// byte-identical mirror of @wp/domain's GROUP_RISK_DISCLOSURE - check-copy
// matches file text; the drift test in website/tests/legal.test.ts pins it
const GROUP_RISK_DISCLOSURE_LITERAL = `Sending promotional messages into WhatsApp groups is one of the highest report-rate behaviours on the platform. A single annoyed member can report the message, and group reports are visible to WhatsApp in a way one-to-one messages are not. WP caps group sending, disables it during warm-up, and switches it off first when your account's health signals worsen — but a group blast is riskier than the same message sent one-to-one, and no pacing changes that.`;

export const FEATURES_COPY = {
  heading: 'Features',
  intro:
    'Every feature below is built around one idea: nothing you send should ever be lost, and your number should stay healthy.',
  items: [
    {
      title: 'Durable queue',
      body: 'Every send is a stored job first, so nothing is lost on a crash or restart.',
    },
    {
      title: 'Paced sending',
      body: 'Warm-up ramps and daily caps pace sending on each connected number.',
    },
    {
      title: 'Safe Mode',
      body: 'Safe Mode watches your account health signals and adjusts pacing automatically.',
      disclosure: SAFE_MODE_DISCLAIMER_LITERAL,
    },
    {
      title: 'Health monitoring',
      body: 'Health monitoring stops sending on a number the moment WhatsApp signals a restriction, keeps the queue, and tells you - it never resumes by itself and never switches you to another number.',
    },
    {
      title: 'Broadcast',
      body: 'Broadcast reaches many recipients as individually-addressed, paced one-to-one messages.',
      disclosure: BROADCAST_DISCLOSURE_LITERAL,
    },
    {
      title: 'Groups',
      body: 'Groups can be included in your sending, with extra caps because of the risk involved.',
      disclosure: GROUP_RISK_DISCLOSURE_LITERAL,
    },
    {
      title: 'Inbox',
      body: 'An inbox for replies, so every reply from a recipient lands in one place.',
    },
    {
      title: 'Wallet metering',
      body: 'Per-message wallet metering keeps usage transparent and prepaid.',
    },
    {
      title: 'Hindi panel',
      body: 'A Hindi panel is available alongside English.',
    },
    {
      title: 'Priority levels',
      body: 'Priority levels order which queued work is sent first - they order work, not a promise of faster delivery.',
    },
  ],
} as const;
