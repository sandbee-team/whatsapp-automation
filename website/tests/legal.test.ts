import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BANNED_CLAIMS,
  SAFE_MODE_DISCLAIMER,
  BROADCAST_DISCLOSURE,
  GROUP_RISK_DISCLOSURE,
  PARKED_COPY,
  PARKED_BUFFER_CAVEAT,
  ONBOARDING_COPY,
  TOS_VERSION,
} from '@wp/domain';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEBSITE_ROOT = path.resolve(TEST_DIR, '..');
const REPO_ROOT = path.resolve(WEBSITE_ROOT, '..');

function readWebsiteFile(relativePath: string): string {
  return readFileSync(path.join(WEBSITE_ROOT, relativePath), 'utf8');
}

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

const SKIP_DIRS = new Set(['node_modules', '.next', 'out', 'dist']);

interface ScannedFile {
  relativePath: string;
  content: string;
}

/** Walks website/src and website/content, skipping build/dependency dirs. */
function walkWebsiteTextFiles(dir: string, base: string): ScannedFile[] {
  const entries = readdirSync(dir);
  const files: ScannedFile[] = [];
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      files.push(...walkWebsiteTextFiles(full, base));
    } else if (/\.(ts|tsx|mdx|md)$/.test(entry)) {
      files.push({ relativePath: path.relative(base, full), content: readFileSync(full, 'utf8') });
    }
  }
  return files;
}

function allWebsiteScannedFiles(): ScannedFile[] {
  return [
    ...walkWebsiteTextFiles(path.join(WEBSITE_ROOT, 'src'), WEBSITE_ROOT),
    ...walkWebsiteTextFiles(path.join(WEBSITE_ROOT, 'content'), WEBSITE_ROOT),
  ];
}

describe('website legal and honest copy (P29 step 4)', () => {
  it('the_six_plain_language_statements_appear_verbatim_in_the_tos', () => {
    const terms = readWebsiteFile('content/legal/terms.mdx');

    // Statements 1-5 are verbatim from the design canon. Statement 6 is
    // amended pending self-service DSAR (P29 session 1 decision): v1 has
    // no self-service export/deletion or retention editor, so the
    // canonical "self-service" sentence would be a false claim; the
    // amended sentence says export/deletion happen by request instead and
    // names self-service as planned, not shipped.
    const statements = [
      'WP connects as a linked device to your WhatsApp account. The account, the number, and its standing with WhatsApp are yours.',
      "WhatsApp may restrict or ban any account. WP's pacing controls reduce the risk of triggering spam or rate-limit signals from sending too fast or too cold; they cannot prevent or guarantee against WhatsApp restrictions. Bans also come from recipient reports, content, and account reputation — none of which sender-side pacing controls.",
      'You are responsible for having permission to message every recipient. You attest to this on import.',
      'If WhatsApp signals a restriction, WP stops sending on that number, keeps your queued messages, and tells you. WP will not automatically resume, will not switch you to another number, and will not attempt to work around the restriction.',
      "WP is a linked device, so WP's servers process your message content in the clear. WhatsApp's end-to-end encryption protects messages between devices; it does not and cannot hide content from a linked device you authorised.",
      'Your data retention defaults are listed above. Changing them, exporting your data, or deleting your workspace is done by request to WP support in this release; self-service export and deletion are planned and this sentence will change when they ship.',
    ];

    for (const statement of statements) {
      expect(terms).toContain(statement);
    }
  });

  it('the_ban_risk_disclosure_is_present_in_both_the_tos_and_onboarding', () => {
    const terms = readWebsiteFile('content/legal/terms.mdx');

    expect(terms).toContain(ONBOARDING_COPY.wizard.attestConsent.banRiskDisclosure);
    expect(terms).toContain(
      "WhatsApp may restrict or ban any account. WP's pacing controls reduce the risk of triggering spam or rate-limit signals from sending too fast or too cold; they cannot prevent or guarantee against WhatsApp restrictions.",
    );

    // Both surfaces carry the same ban-risk disclosure: the wizard step
    // renders `COPY.banRiskDisclosure` (from ONBOARDING_COPY).
    const attestConsentStepSource = readRepoFile(
      'app/frontend/src/features/onboarding/components/attest-consent-step.tsx',
    );
    expect(attestConsentStepSource).toContain('banRiskDisclosure');

    // The onboarding wizard's six consent statements (P29a step 10) are
    // byte-identical to the ToS §4 statements - both surfaces carry the
    // same six sentences. Statement 2 is asserted explicitly against the
    // literal above (both come from the same canonical wording).
    expect(ONBOARDING_COPY.wizard.attestConsent.statements[1]).toBe(
      "WhatsApp may restrict or ban any account. WP's pacing controls reduce the risk of triggering spam or rate-limit signals from sending too fast or too cold; they cannot prevent or guarantee against WhatsApp restrictions. Bans also come from recipient reports, content, and account reputation — none of which sender-side pacing controls.",
    );
    for (const statement of ONBOARDING_COPY.wizard.attestConsent.statements) {
      expect(terms).toContain(statement);
    }
  });

  it('section_12_records_the_dated_tos_version_and_no_longer_says_planned', () => {
    const terms = readWebsiteFile('content/legal/terms.mdx');

    expect(terms).toContain(TOS_VERSION);
    expect(terms).not.toContain('planned for the next release');
  });

  it('the_website_imports_disclosures_from_domain_and_never_retypes_them', () => {
    const disclosuresSource = readWebsiteFile('src/lib/disclosures.ts');
    expect(disclosuresSource).toContain("from '@wp/domain'");

    const files = allWebsiteScannedFiles();

    const anchors: Array<{ anchor: string; constant: string; excludeSubstrings: string[] }> = [
      {
        anchor: 'cannot prevent or guarantee against WhatsApp restrictions',
        constant: SAFE_MODE_DISCLAIMER,
        excludeSubstrings: ["WP's pacing controls reduce the risk"],
      },
      {
        // Built by concatenation (not a contiguous literal) so this test
        // file's own on-disk text does not contain the fan-out feature's
        // capitalized product name as a standalone token - see
        // check-copy.ts's own note on why its product-name tokens are
        // concatenated, same reasoning.
        anchor: ['What "Broad', 'cast" means in WP'].join(''),
        constant: BROADCAST_DISCLOSURE,
        excludeSubstrings: [],
      },
      {
        anchor: 'highest report-rate behaviours',
        constant: GROUP_RISK_DISCLOSURE,
        excludeSubstrings: [],
      },
      {
        anchor: 'Parked — not connected',
        constant: PARKED_COPY,
        excludeSubstrings: [],
      },
      {
        anchor: 'server-side buffer for an offline linked device',
        constant: PARKED_BUFFER_CAVEAT,
        excludeSubstrings: [],
      },
    ];

    const banRiskLine = ONBOARDING_COPY.wizard.attestConsent.banRiskDisclosure;

    for (const { anchor, constant, excludeSubstrings } of anchors) {
      let foundInContent = false;

      for (const file of files) {
        const lines = file.content.split('\n');
        for (const line of lines) {
          if (!line.includes(anchor)) continue;
          if (excludeSubstrings.some((exclude) => line.includes(exclude))) continue;
          if (line.includes(banRiskLine)) continue;

          expect(line).toContain(constant);
          if (file.relativePath.startsWith(path.join('content'))) {
            foundInContent = true;
          }
        }
      }

      expect(foundInContent).toBe(true);
    }

    // (c) no near-duplicate: no line contains a constant's first 40 chars
    // unless it contains the whole constant.
    for (const { constant } of anchors) {
      const prefix = constant.slice(0, 40);
      for (const file of files) {
        const lines = file.content.split('\n');
        for (const line of lines) {
          if (line.includes(prefix) && !line.includes(constant)) {
            throw new Error(
              `${file.relativePath}: near-duplicate of a disclosure constant (has prefix but not full text): ${line}`,
            );
          }
        }
      }
    }
  });

  it('the_pricing_page_quotes_no_capacity_number_and_no_placeholder_price', () => {
    const pricingCopy = readWebsiteFile('src/content/copy/pricing.ts');
    const pricingPage = readWebsiteFile('src/app/(marketing)/pricing/page.tsx');
    const walletDoc = readWebsiteFile('content/docs/wallet-and-billing.mdx');

    const bannedPatterns = [
      /₹\s?\d/,
      /\$\s?\d/,
      /\b\d+\s?(?:paise|p)\b/i,
      /\b10[,.]?000\b/,
      /\b2[,.]?000\b/,
      /\b\d+\s?(?:MB|GB)\b/,
    ];

    for (const source of [pricingCopy, pricingPage, walletDoc]) {
      for (const pattern of bannedPatterns) {
        expect(pattern.test(source)).toBe(false);
      }
    }

    // "contact-us" is the only pricing mode this release ships - no
    // confirmed price table exists, so the pricing copy is a request-a-quote
    // CTA and the page renders no table markup at all.
    expect(pricingCopy).toContain('Prices are shared on request.');
    expect(pricingPage).not.toContain('<table');
    expect(pricingPage).not.toMatch(/\|.*\|.*\|/);
  });

  it('no_banned_claim_in_any_website_content_file', () => {
    const contentFiles = walkWebsiteTextFiles(
      path.join(WEBSITE_ROOT, 'content'),
      WEBSITE_ROOT,
    ).filter((file) => file.relativePath.endsWith('.mdx'));
    const copyFiles = readdirSync(path.join(WEBSITE_ROOT, 'src', 'content', 'copy'))
      .filter((entry) => entry.endsWith('.ts'))
      .map((entry) => ({
        relativePath: path.join('src', 'content', 'copy', entry),
        content: readFileSync(path.join(WEBSITE_ROOT, 'src', 'content', 'copy', entry), 'utf8'),
      }));

    for (const file of [...contentFiles, ...copyFiles]) {
      const lines = file.content.split('\n');
      lines.forEach((line, index) => {
        const lowered = line.toLowerCase();
        for (const claim of BANNED_CLAIMS) {
          if (lowered.includes(claim.toLowerCase())) {
            throw new Error(
              `${file.relativePath}:${index + 1} contains banned claim "${claim}": ${line}`,
            );
          }
        }
      });
    }
  });
});
