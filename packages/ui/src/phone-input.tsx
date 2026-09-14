'use client';

import * as React from 'react';
import { cx } from './lib/cx.js';
import { Input } from './input.js';
import { Select, type SelectOption } from './select.js';

/**
 * PhoneInput - a design-system `Select` country picker (flag emoji + dial
 * code, e.g. "🇮🇳 +91") plus an `Input` for the national number; emits the
 * dial code immediately followed
 * by the national digits as one E.164 string. No external phone-validation
 * library: the caller's zod schema owns validation, this component only
 * assembles/splits the E.164 string. Parsing an incoming E.164 value picks
 * the LONGEST matching dial code (so e.g. `+1` does not shadow a
 * hypothetical 2-digit code sharing its first character).
 */
export interface PhoneCountry {
  iso: string;
  dial: string;
  label: string;
}

export interface PhoneInputProps {
  label: string;
  description?: string;
  error?: string;
  /** E.164 string (e.g. "+919000000000") or ''. */
  value: string;
  onValueChange: (e164: string) => void;
  countries?: PhoneCountry[];
  defaultIso?: string;
  /** Accessible label for the country `Select`. */
  countryLabel: string;
  disabled?: boolean;
  className?: string;
}

const FLAG_OFFSET = 127397; // regional indicator symbol offset from 'A'

function flagEmoji(iso: string): string {
  return [...iso.toUpperCase()]
    .map((char) => String.fromCodePoint(char.charCodeAt(0) + FLAG_OFFSET))
    .join('');
}

const ISO_LIST: Array<[string, string]> = [
  ['IN', '91'],
  ['US', '1'],
  ['GB', '44'],
  ['AE', '971'],
  ['SG', '65'],
  ['AU', '61'],
  ['CA', '1'],
  ['DE', '49'],
  ['FR', '33'],
  ['BR', '55'],
  ['ZA', '27'],
  ['NG', '234'],
  ['KE', '254'],
  ['BD', '880'],
  ['PK', '92'],
  ['LK', '94'],
  ['NP', '977'],
  ['ID', '62'],
  ['MY', '60'],
  ['PH', '63'],
];

export const DEFAULT_PHONE_COUNTRIES: PhoneCountry[] = ISO_LIST.map(([iso, dial]) => ({
  iso,
  dial,
  label: `${flagEmoji(iso)} +${dial}`,
}));

const DIGITS_AND_SPACES_PATTERN = /[^\d\s]/g;

const FALLBACK_COUNTRY: PhoneCountry = { iso: '', dial: '', label: '' };

function findCountryByIso(countries: PhoneCountry[], iso: string): PhoneCountry {
  return countries.find((c) => c.iso === iso) ?? countries[0] ?? FALLBACK_COUNTRY;
}

/** Picks the longest matching dial code for an incoming E.164 string. */
function parseE164(value: string, countries: PhoneCountry[]): { iso: string; national: string } {
  const digits = value.replace(/^\+/, '');
  const sorted = [...countries].sort((a, b) => b.dial.length - a.dial.length);
  for (const country of sorted) {
    if (digits.startsWith(country.dial)) {
      return { iso: country.iso, national: digits.slice(country.dial.length) };
    }
  }
  return { iso: countries[0]?.iso ?? '', national: digits };
}

export function PhoneInput({
  label,
  description,
  error,
  value,
  onValueChange,
  countries = DEFAULT_PHONE_COUNTRIES,
  defaultIso = 'IN',
  countryLabel,
  disabled,
  className,
}: PhoneInputProps): React.JSX.Element {
  const parsed = value ? parseE164(value, countries) : { iso: defaultIso, national: '' };

  function emit(iso: string, national: string) {
    const country = findCountryByIso(countries, iso);
    const digits = national.replace(/\s/g, '');
    onValueChange(digits === '' ? '' : `+${country.dial}${digits}`);
  }

  const countryOptions: SelectOption[] = countries.map((country) => ({
    value: country.iso,
    label: country.label,
  }));

  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <div className="flex gap-2">
        <Select
          label={countryLabel}
          placeholder={countryLabel}
          options={countryOptions}
          value={parsed.iso || null}
          onValueChange={(iso) => emit(iso, parsed.national)}
          disabled={disabled}
          className="w-28 min-w-[7rem] rounded-r-none"
        />
        <div className="flex-1">
          <Input
            label={label}
            description={description}
            error={error}
            value={parsed.national}
            disabled={disabled}
            onChange={(event) => {
              const cleaned = event.target.value.replace(DIGITS_AND_SPACES_PATTERN, '');
              emit(parsed.iso, cleaned);
            }}
          />
        </div>
      </div>
    </div>
  );
}
