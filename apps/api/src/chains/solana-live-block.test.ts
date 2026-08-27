import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./solana.ts', import.meta.url), 'utf8');

describe('legacy Solana adapter live safety', () => {
  it('does not broadcast sendTransaction or claim confirmation', () => {
    const execute = source.slice(source.indexOf('async execute'), source.indexOf('/** Paper-режим'));
    expect(execute).not.toContain("method: 'sendTransaction'");
    expect(execute).not.toContain("status: 'CONFIRMED'");
    expect(execute).toContain('LIVE_SOLANA_EXECUTION_NOT_IMPLEMENTED');
  });
});
