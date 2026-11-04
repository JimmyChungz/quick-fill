import { describe, it, expect } from 'vitest';
import { normalizeOrigin } from '../src/lib/origin';

describe('normalizeOrigin', () => {
  it('keeps an https URL as https', () => {
    expect(normalizeOrigin('https://example.com')).toBe('https://example.com');
    expect(normalizeOrigin('https://example.com/path?x=1')).toBe('https://example.com');
  });

  it('upgrades a bare https-looking host to https://', () => {
    expect(normalizeOrigin('github.com')).toBe('https://github.com');
    expect(normalizeOrigin('www.example.com')).toBe('https://www.example.com');
  });

  it('keeps localhost on http', () => {
    expect(normalizeOrigin('localhost')).toBe('http://localhost');
    expect(normalizeOrigin('localhost:8080')).toBe('http://localhost:8080');
    expect(normalizeOrigin('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('keeps 127.0.0.1 / .local on http', () => {
    expect(normalizeOrigin('127.0.0.1')).toBe('http://127.0.0.1');
    expect(normalizeOrigin('127.0.0.1:3000/path')).toBe('http://127.0.0.1:3000');
    expect(normalizeOrigin('mybox.local')).toBe('http://mybox.local');
  });

  it('returns empty string for blank input', () => {
    expect(normalizeOrigin('')).toBe('');
    expect(normalizeOrigin('   ')).toBe('');
  });

  it('returns raw text for unparseable garbage', () => {
    expect(normalizeOrigin('not a url at all !!!')).toBe('not a url at all !!!');
  });
});
