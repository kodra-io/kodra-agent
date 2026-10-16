import { describe, expect, it } from 'vitest';
import { DataMasker, ibanValid, luhn } from './data-protection.ts';

const KEY = Buffer.alloc(32, 7);
const all = () =>
  new DataMasker({
    redact: ['cards', 'ibans', 'emails', 'phones'],
    patterns: [{ name: 'customer-id', regex: '\\bCUST-[0-9]{8}\\b' }],
    key: KEY,
  });

/** Made-up values: test card numbers, a valid-format IBAN, example.com addresses. */
const VISA = '4111 1111 1111 1111';
const MASTERCARD = '5555-5555-5555-4444';
const AMEX = '378282246310005';
const IBAN_DE = 'DE89370400440532013000';
const IBAN_GB_SPACED = 'GB82 WEST 1234 5698 7654 32';

describe('checksums', () => {
  it('checks Luhn and IBAN mod-97', () => {
    expect(luhn('4111111111111111')).toBe(true);
    expect(luhn('4111111111111112')).toBe(false);
    expect(ibanValid(IBAN_DE)).toBe(true);
    expect(ibanValid('DE89370400440532013001')).toBe(false);
  });
});

describe('DataMasker on realistic log lines', () => {
  it.each([
    [
      `ERROR payment declined card=${VISA} user=jane.doe@example.com retry=0`,
      'ERROR payment declined card=[card:',
      ['4111', 'jane.doe@example.com'],
    ],
    [
      `{"level":"warn","msg":"refund failed","pan":"${MASTERCARD}","iban":"${IBAN_DE}"}`,
      '"pan":"[card:',
      ['5555', IBAN_DE],
    ],
    [
      `2026-10-16T08:33:37Z checkout-7d9f charge amex ${AMEX} for order 88231 ok=false`,
      'charge amex [card:',
      [AMEX],
    ],
    [
      `SEPA transfer to ${IBAN_GB_SPACED} rejected: insufficient funds`,
      'SEPA transfer to [iban:',
      ['WEST 1234'],
    ],
    [
      'notify: SMS to +44 7700 900123 and +1 (555) 010-4477 failed, fallback 0044 20 7946 0958',
      'notify: SMS to [phone:',
      ['7700 900123', '010-4477', '7946 0958'],
    ],
    [
      'lookup CUST-00412345 not found for customer@example.org',
      'lookup [customer-id:',
      ['CUST-00412345', 'customer@example.org'],
    ],
  ])('masks %s', (line, starts, gone) => {
    const out = all().mask(line);
    expect(out).toContain(starts);
    for (const value of gone) expect(out).not.toContain(value);
  });

  it('masks values that end a sentence, but not part of a longer number or name', () => {
    const out = all().mask(`Refund ${VISA}. Write to jane@example.com.`);
    expect(out).toMatch(/^Refund \[card:[0-9a-f]{4}\]\. Write to \[email:[0-9a-f]{4}\]\.$/);
    // A decimal part keeps the number whole; .au is part of the address, not a full stop.
    expect(all().mask('value 4111111111111111.25 and jane@example.com.au')).toMatch(
      /^value 4111111111111111\.25 and \[email:[0-9a-f]{4}\]$/,
    );
  });

  it('gives the same value the same placeholder, and another key different ones', () => {
    const masker = all();
    const a = masker.mask('first jane.doe@example.com');
    const b = masker.mask('again Jane.Doe@Example.com and bob@example.com');
    const tag = /\[email:[0-9a-f]{4}\]/.exec(a)?.[0] ?? 'missing';
    expect(b).toContain(tag);
    expect(b.match(/\[email:[0-9a-f]{4}\]/g)).toHaveLength(2);
    const other = new DataMasker({ redact: ['emails'], patterns: [] });
    expect(other.mask('first jane.doe@example.com')).not.toContain(tag);
  });

  it('counts what it masked, by type', () => {
    const counts: Record<string, number> = {};
    all().mask(`${VISA} ${MASTERCARD} jane@example.com ${IBAN_DE}`, counts);
    expect(counts).toEqual({ card: 2, iban: 1, email: 1 });
  });

  it('masks only the detectors the config turns on', () => {
    const cardsOnly = new DataMasker({ redact: ['cards'], patterns: [], key: KEY });
    expect(cardsOnly.mask(`${VISA} jane@example.com`)).toMatch(
      /^\[card:[0-9a-f]{4}\] jane@example.com$/,
    );
    expect(new DataMasker({ redact: [], patterns: [] }).active).toBe(false);
  });
});

describe('DataMasker leaves operational data alone', () => {
  it.each([
    ['RFC 3339 timestamp', '2026-10-16T08:33:37.123456789Z level=info'],
    ['epoch milliseconds', 'ts=1760603617123 took=1760603617'],
    ['compact timestamp', 'backup-20261016083337.tar.gz'],
    ['UUID', 'request 3f2504e0-4f89-11d3-9a0c-0305e82c3301 done'],
    ['digit-only UUID', 'id 12345678-1234-5678-1234-567812345678'],
    [
      'image digest',
      'image nginx@sha256:4111111111111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ],
    ['trace and span ids', 'trace_id=4bf92f3577b34da6a3ce929d0e0e4736 span_id=00f067aa0ba902b7'],
    ['W3C traceparent', 'traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
    ['ports and addresses', 'listening on 0.0.0.0:8080, upstream 10.96.0.1:443, [::1]:9090'],
    ['metric values', 'http_requests_total{code="500"} 4111111111111111.5 1760603617123'],
    ['Kubernetes resource versions', 'resourceVersion: "41111111111111111" generation: 3'],
    ['pod names', 'pod checkout-7d9f8b6c5d-x2k4p restarted 12 times'],
    ['time zone offsets', 'at 2026-10-16 11:33:37 +03:00 (+0300)'],
    ['durations and sizes', 'took 00:01:23.456, size 4111111111 bytes'],
    ['versions', 'kodra-agent 0.2.0, node v24.21.0, helm v4.3.0'],
    ['git SHAs', 'commit 4111111111111111111111111111111111111111'],
  ])('%s', (_name, line) => {
    expect(all().mask(line)).toBe(line);
  });
});
