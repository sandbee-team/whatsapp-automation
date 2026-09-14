// @vitest-environment jsdom
import * as React from 'react';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import axe from 'axe-core';
import {
  I18nProvider,
  useT,
  type Locale,
  Button,
  Input,
  Card,
  CardHeader,
  CardTitle,
  CardBody,
  CardFooter,
  Badge,
  Sheet,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  ToastProvider,
  useToast,
  EmptyState,
  Spinner,
} from '../src/index.js';
import { coreFixtures } from './fixtures/core.fixtures.js';
import { overlayFixtures } from './fixtures/overlay.fixtures.js';
import { chartsFixtures } from './fixtures/charts.fixtures.js';
import type { Fixture } from './fixtures/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '../src');

const LOCALES: Locale[] = ['en', 'hi'];

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: {
    // jsdom has no layout engine (no real rendering/paint), so contrast
    // cannot be computed meaningfully here - contrast is a design-token
    // property, not a component-structure property, and is out of scope for
    // this DOM-structure a11y proof.
    'color-contrast': { enabled: false },
  },
};

/** One toast pre-populated via a helper that calls showToast() on mount. */
function ToastFixture(): React.JSX.Element {
  const t = useT();
  return <ToastShower label={t('common.loading')} />;
}

function ToastShower({ label }: { label: string }): React.JSX.Element {
  const { showToast } = useToast();
  const shown = React.useRef(false);
  if (!shown.current) {
    shown.current = true;
    showToast({ title: label, tone: 'info' });
  }
  return <></>;
}

function useFixtures(): Fixture[] {
  return [
    { name: 'Button', render: () => <Button>Save</Button> },
    {
      name: 'Button (loading)',
      render: () => (
        <Button loading loadingLabel="Loading">
          Save
        </Button>
      ),
    },
    {
      name: 'Input',
      render: () => <Input label="Recovery code" error="That recovery code is not valid." />,
    },
    {
      name: 'Card',
      render: () => (
        <Card>
          <CardHeader>
            <CardTitle>Dashboard</CardTitle>
          </CardHeader>
          <CardBody>An overview of your connected numbers.</CardBody>
          <CardFooter>
            <Button size="sm">Continue</Button>
          </CardFooter>
        </Card>
      ),
    },
    { name: 'Badge', render: () => <Badge tone="success">Live</Badge> },
    {
      name: 'Sheet',
      render: () => (
        <Sheet
          open
          title="Account recovery"
          description="Enter your recovery code."
          closeLabel="Close"
        >
          <p>Sheet body content.</p>
        </Sheet>
      ),
    },
    {
      name: 'Table',
      render: () => (
        <Table caption="Connected numbers">
          <THead>
            <TR>
              <TH>Number</TH>
              <TH>Status</TH>
            </TR>
          </THead>
          <TBody>
            <TR>
              <TD>+91 90000 00000</TD>
              <TD>Live</TD>
            </TR>
          </TBody>
        </Table>
      ),
    },
    {
      name: 'ToastProvider',
      render: () => (
        <ToastProvider>
          <ToastFixture />
        </ToastProvider>
      ),
    },
    {
      name: 'EmptyState',
      render: () => (
        <EmptyState
          title="No numbers connected yet"
          body="Connect a number to get started."
          action={<Button size="sm">Connect a number</Button>}
        />
      ),
    },
    { name: 'Spinner', render: () => <Spinner aria-label="Loading" /> },
    ...coreFixtures,
    ...overlayFixtures,
    ...chartsFixtures,
  ];
}

describe('every_exported_primitive_has_zero_axe_violations', () => {
  afterEach(() => {
    cleanup();
  });

  for (const locale of LOCALES) {
    describe(`locale=${locale}`, () => {
      const fixtures = useFixtures();
      for (const fixture of fixtures) {
        it(`${fixture.name} has zero axe violations`, async () => {
          const { container } = render(
            <I18nProvider locale={locale}>{fixture.render()}</I18nProvider>,
          );

          const results = await axe.run(container, AXE_OPTIONS);

          if (results.violations.length > 0) {
            const ids = results.violations.map((violation) => violation.id).join(', ');
            expect.fail(`axe violations for ${fixture.name} (${locale}): ${ids}`);
          }
          expect(results.violations.length).toBe(0);
        });
      }
    });
  }
});

describe('every_interactive_component_file_starts_with_use_client', () => {
  const INTERACTIVE_MARKER_PATTERN =
    /\bonClick\b|\bonChange\b|\bonSubmit\b|\buseState\(|\buseEffect\(|\buseRef\(|\buseReducer\(|\bonKeyDown\b|\bonPointer\w*\b/;
  const USE_CLIENT_DIRECTIVE = "'use client'";

  function startsWithUseClientDirective(content: string): boolean {
    let rest = content;
    let previousLength = -1;
    while (rest.length !== previousLength) {
      previousLength = rest.length;
      rest = rest.replace(/^\s+/, '');
      rest = rest.replace(/^\/\*[\s\S]*?\*\//, '');
      rest = rest.replace(/^\/\/[^\n]*\n?/, '');
    }
    return rest.startsWith(USE_CLIENT_DIRECTIVE) || rest.startsWith('"use client"');
  }

  function listTsxFiles(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...listTsxFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.tsx')) {
        files.push(fullPath);
      }
    }
    return files;
  }

  it('every interactive .tsx file in src carries a leading use client directive', () => {
    const files = listTsxFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const filePath of files) {
      const content = readFileSync(filePath, 'utf8');
      if (INTERACTIVE_MARKER_PATTERN.test(content) && !startsWithUseClientDirective(content)) {
        missing.push(path.relative(SRC_DIR, filePath));
      }
    }

    expect(missing).toEqual([]);
  });
});

describe('no_component_file_contains_a_raw_colour_literal', () => {
  const HEX_COLOUR_PATTERN =
    /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b(?!-)/g;
  const HEX_ALLOWLIST_LINE_PATTERN = /getElementById|href\s*=|url\(#/;
  const COLOUR_FUNCTION_PATTERN = /\b(?:rgba?|hsla?|oklch)\(/;

  function listSourceFiles(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...listSourceFiles(fullPath));
      } else if (entry.isFile() && /\.(ts|tsx|css)$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
    return files;
  }

  it('no .ts/.tsx/.css file under src contains a raw hex/rgb/hsl/oklch colour literal', () => {
    const files = listSourceFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const filePath of files) {
      const content = readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, index) => {
        if (HEX_ALLOWLIST_LINE_PATTERN.test(line)) return;
        HEX_COLOUR_PATTERN.lastIndex = 0;
        if (HEX_COLOUR_PATTERN.test(line) || COLOUR_FUNCTION_PATTERN.test(line)) {
          violations.push(`${path.relative(SRC_DIR, filePath)}:${String(index + 1)}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
