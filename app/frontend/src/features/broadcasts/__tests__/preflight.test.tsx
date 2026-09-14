// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { I18nProvider, type Locale } from '@wp/ui';
import { BROADCAST_DISCLOSURE, GROUP_RISK_DISCLOSURE, BANNED_CLAIMS } from '@wp/domain';
import { broadcastPreflightSchema, type BroadcastPreflight } from '@wp/contracts';
import { PreflightPanel } from '../components/preflight-panel.js';

/**
 * preflight.test.tsx (P23a Unit U3, step 4) - proves `PreflightPanel`'s
 * honest-copy and money-rendering surface. The fixture quote is built to
 * satisfy `broadcastPreflightSchema.parse` (same idiom as
 * `wallet-banner.test.tsx`'s `it.each<Locale>` + `I18nProvider` shape) - no
 * fetching happens in this component, so no `fetch` stub is needed.
 */

const BASE_QUOTE_INPUT = {
  broadcastId: '11111111-1111-4111-8111-111111111111',
  audience: {
    matched: 100,
    skipped: 2,
    skipReasons: [
      { reason: 'opted_out', count: 1 },
      { reason: 'missing_var:city', count: 1 },
    ],
    sendable: 98,
  },
  alreadyMessaged: {
    deferred: 3,
    perRecipient24h: 1,
    perRecipient7d: 3,
    note: 'Sending the same audience from another number does not increase how often a person can be messaged — the frequency limit is per workspace.',
  },
  billable: {
    count: 95,
    priceKey: 'default',
    rateMinor: 30,
    quoteMinor: 2850,
  },
  wallet: {
    balanceMinor: 5000,
    afterMinor: 2150,
    sufficient: true,
  },
  account: {
    instanceId: '22222222-2222-4222-8222-222222222222',
    label: 'Sales team',
    warmupTier: 3,
    effDailyCap: 500,
    sentToday: 50,
    remainingToday: 450,
  },
  estimate: {
    totalDays: 2,
    finishAt: '2026-09-08T12:00:00.000Z',
    caveat: 'This is an estimate, not a guarantee.',
    options: ['reduce_audience', 'wait_for_warm_up'],
  },
  fanOut: {
    warnThreshold: 30,
    ackThreshold: 60,
    requiresHumanAck: false,
  },
  disclosure: BROADCAST_DISCLOSURE,
} satisfies Record<string, unknown>;

function buildQuote(
  overrides: Partial<typeof BASE_QUOTE_INPUT> & { groups?: BroadcastPreflight['groups'] } = {},
): BroadcastPreflight {
  return broadcastPreflightSchema.parse({ ...BASE_QUOTE_INPUT, ...overrides });
}

function renderPanel(
  locale: Locale,
  quote: BroadcastPreflight,
  props: Partial<{ onStart: () => void; onBack: () => void; starting: boolean }> = {},
): void {
  render(
    <I18nProvider locale={locale}>
      <PreflightPanel
        quote={quote}
        onStart={props.onStart ?? (() => undefined)}
        onBack={props.onBack ?? (() => undefined)}
        starting={props.starting ?? false}
      />
    </I18nProvider>,
  );
}

describe('PreflightPanel', () => {
  afterEach(() => {
    cleanup();
  });

  it.each<Locale>(['en', 'hi'])(
    'every_broadcast_surface_shows_the_broadcast_disclosure (%s)',
    (locale) => {
      const quote = buildQuote();
      renderPanel(locale, quote);

      const disclosure = screen.getByTestId('broadcast-disclosure');
      expect(disclosure.textContent).toBe(BROADCAST_DISCLOSURE);

      const estimateBlock = screen.getByTestId('preflight-estimate');
      const expectedCaveat =
        locale === 'en' ? 'This is an estimate, not a guarantee.' : 'यह एक अनुमान है, गारंटी नहीं।';
      expect(estimateBlock.textContent ?? '').toContain(expectedCaveat);

      const panel = screen.getByTestId('preflight-panel');
      const expectedFrequencyLine =
        locale === 'en'
          ? 'Sending the same audience from another number does not increase how often a person can be messaged — the frequency limit is per workspace.'
          : 'किसी और नंबर से वही ऑडियंस भेजने से किसी व्यक्ति को भेजे जाने वाले संदेशों की संख्या नहीं बढ़ती - फ्रीक्वेंसी सीमा पूरे वर्कस्पेस के लिए एक होती है।';
      expect(panel.textContent ?? '').toContain(expectedFrequencyLine);
    },
  );

  it('the_quote_renders_integer_paise_as_rupees_without_float_drift', () => {
    const quote = buildQuote({
      billable: { count: 95, priceKey: 'default', rateMinor: 30045, quoteMinor: 30045 },
      wallet: { balanceMinor: 15, afterMinor: -30030, sufficient: false },
    });
    renderPanel('en', quote);

    const panel = screen.getByTestId('preflight-panel');
    const text = panel.textContent ?? '';
    expect(text).toContain('₹300.45');
    expect(text).toContain('₹0.15');
  });

  it('no_faster_mode_control_exists_and_only_the_two_honest_options_render', () => {
    const quote = buildQuote();
    renderPanel('en', quote);

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/faster/i);
    expect(text).not.toMatch(/boost/i);
    expect(text).not.toMatch(/speed up/i);
    expect(text).not.toMatch(/instant/i);

    const optionItems = screen.getAllByTestId('preflight-option');
    expect(optionItems).toHaveLength(2);
    expect(optionItems[0]?.textContent).toContain('reduce the audience');
    expect(optionItems[1]?.textContent).toContain('wait for warm-up to raise the daily cap');

    const lowerText = text.toLowerCase();
    for (const claim of BANNED_CLAIMS) {
      expect(lowerText).not.toContain(claim.toLowerCase());
    }
  });

  it('a_fan_out_over_the_profile_threshold_shows_the_ack_notice_with_that_threshold', () => {
    const quote = buildQuote({
      fanOut: { warnThreshold: 30, ackThreshold: 60, requiresHumanAck: true },
    });
    renderPanel('en', quote);

    const notice = screen.getByTestId('preflight-fanout-notice');
    expect(notice.textContent ?? '').toContain('60');
  });

  it('the_groups_preflight_shows_reach_cap_and_disclosure_above_confirm', () => {
    const quote = buildQuote({
      groups: {
        groupsMatched: 4,
        groupsSkipped: 1,
        skipReasons: [{ reason: 'group_forbidden', count: 1 }],
        reachEstimate: 800,
        reachIsApproximate: true,
        effGroupDailyCap: 50,
        groupSentToday: 10,
        groupRemainingToday: 40,
        capIsZeroAtTier: false,
        riskDisclosure: GROUP_RISK_DISCLOSURE,
      },
    });
    renderPanel('en', quote);

    const groupsSection = screen.getByTestId('preflight-groups');
    expect(groupsSection.textContent ?? '').toContain('800');
    expect(groupsSection.textContent ?? '').toContain('4');
    expect(groupsSection.textContent ?? '').toContain('40');
    expect(groupsSection.textContent ?? '').toContain('50');
    expect(groupsSection.textContent ?? '').toContain('1 groups skipped');

    const groupDisclosure = screen.getByTestId('group-header-disclosure');
    expect(groupDisclosure.textContent).toBe(GROUP_RISK_DISCLOSURE);

    // DOM order: the group disclosure precedes the Start button.
    const panel = screen.getByTestId('preflight-panel');
    const allNodes = Array.from(
      panel.querySelectorAll('[data-testid="group-header-disclosure"], button'),
    );
    const disclosureIndex = allNodes.findIndex(
      (node) => node.getAttribute('data-testid') === 'group-header-disclosure',
    );
    const startButtonIndex = allNodes.findIndex((node) => node.textContent === 'Start broadcast');
    expect(disclosureIndex).toBeGreaterThanOrEqual(0);
    expect(startButtonIndex).toBeGreaterThan(disclosureIndex);
  });

  it('cap_zero_at_tier_shows_the_off_at_tier_line', () => {
    const quote = buildQuote({
      groups: {
        groupsMatched: 4,
        groupsSkipped: 0,
        skipReasons: [],
        reachEstimate: 0,
        reachIsApproximate: true,
        effGroupDailyCap: 0,
        groupSentToday: 0,
        groupRemainingToday: 0,
        capIsZeroAtTier: true,
        riskDisclosure: GROUP_RISK_DISCLOSURE,
      },
    });
    renderPanel('en', quote);

    const groupsSection = screen.getByTestId('preflight-groups');
    expect(groupsSection.textContent ?? '').toContain(
      'group sending is off at your current warm-up tier',
    );
  });
});
