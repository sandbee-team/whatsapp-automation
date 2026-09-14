// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider, type Locale } from '@wp/ui';
import { ImportWizard } from '../ImportWizard.js';
import { ImportResult } from '../ImportResult.js';

/**
 * import-wizard.test.tsx (P20 Unit U9, step 10) - same locale-parametrized +
 * `I18nProvider`/`QueryClientProvider` shape as
 * `features/wallet/__tests__/wallet-banner.test.tsx`.
 */
function renderWizard(locale: Locale): void {
  const queryClient = new QueryClient();
  render(
    <I18nProvider locale={locale}>
      <QueryClientProvider client={queryClient}>
        <ImportWizard
          open
          onOpenChange={() => undefined}
          onCompleted={() => undefined}
          initialStep="attestation"
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe('ImportWizard attestation step', () => {
  afterEach(() => {
    cleanup();
  });

  it.each<Locale>(['en', 'hi'])(
    'the_attestation_step_renders_the_verbatim_sentence_and_gates_the_start_button (%s)',
    (locale) => {
      renderWizard(locale);

      expect(screen.getByTestId('import-attestation-notice').textContent).toBe(
        'We record who asserted consent; we do not and cannot verify it.',
      );

      const startButton = screen.getByTestId('import-attestation-start') as HTMLButtonElement;
      expect(startButton.disabled).toBe(true);

      fireEvent.click(screen.getByTestId('import-attestation-checkbox'));
      expect(startButton.disabled).toBe(true);

      fireEvent.change(screen.getByTestId('import-attestation-source'), {
        target: { value: 'abc' },
      });
      expect(startButton.disabled).toBe(false);
    },
  );
});

describe('ImportResult', () => {
  afterEach(() => {
    cleanup();
  });

  it('the_result_screen_shows_five_counters_and_the_error_csv_action_only_when_invalid_rows_exist', () => {
    const { rerender } = render(
      <I18nProvider locale="en">
        <ImportResult
          item={{
            status: 'done',
            importedCount: 10,
            updatedCount: 2,
            duplicateCount: 1,
            invalidCount: 0,
            optedOutCount: 0,
            lastErrorReason: null,
          }}
          onDownloadErrors={() => undefined}
          onClose={() => undefined}
        />
      </I18nProvider>,
    );

    expect(screen.getByTestId('import-result-imported').textContent).toBe('10');
    expect(screen.getByTestId('import-result-updated').textContent).toBe('2');
    expect(screen.getByTestId('import-result-duplicates').textContent).toBe('1');
    expect(screen.getByTestId('import-result-invalid').textContent).toBe('0');
    expect(screen.getByTestId('import-result-opted-out').textContent).toBe('0');
    expect(screen.queryByTestId('import-result-download-errors')).toBeNull();

    rerender(
      <I18nProvider locale="en">
        <ImportResult
          item={{
            status: 'done',
            importedCount: 5,
            updatedCount: 0,
            duplicateCount: 0,
            invalidCount: 3,
            optedOutCount: 0,
            lastErrorReason: null,
          }}
          onDownloadErrors={() => undefined}
          onClose={() => undefined}
        />
      </I18nProvider>,
    );

    expect(screen.getByTestId('import-result-invalid').textContent).toBe('3');
    expect(screen.getByTestId('import-result-download-errors')).not.toBeNull();
    expect(screen.getByTestId('import-result-invalid-note')).not.toBeNull();
  });
});
