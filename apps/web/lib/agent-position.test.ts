import { describe, expect, it } from 'vitest';
import { agentChartHref, splitAgentDecisions } from './agent-position';

describe('position links and event categories', () => {
  it.each(['SOLANA', 'ETHEREUM', 'BASE', 'BNB', 'ROBINHOOD'])('preserves %s alongside id and address without inserting basePath', chain => {
    const href = agentChartHref({ chain, tokenId: 'id +/?', address: 'address/?&' });
    expect(href?.startsWith('/terminal/?')).toBe(true);
    expect(href).not.toContain('memex-dex');
    const query = new URL(href!, 'https://example.invalid').searchParams;
    expect(query.get('chain')).toBe(chain);
    expect(query.get('token')).toBe('id +/?');
    expect(query.get('address')).toBe('address/?&');
  });
  it('supports chain/address resolution and legacy id-only resolution', () => {
    expect(agentChartHref({ chain: 'solana', address: 'mint' })).toBe('/terminal/?chain=SOLANA&address=mint');
    expect(agentChartHref({ tokenId: 'known' })).toBe('/terminal/?token=known');
    expect(agentChartHref({})).toBeNull();
    expect(agentChartHref({ address: 'mint' })).toBeNull();
    expect(agentChartHref({ tokenId: 'known', chain: 'UNKNOWN' })).toBeNull();
  });
  it('never counts pending, failed, open or closed decisions as skipped', () => {
    const states = ['RECEIVED', 'ELIGIBLE', 'WAITING_PRICE', 'WAITING_ENTRY', 'SKIPPED', 'ERROR', 'PAPER_OPEN', 'PAPER_CLOSED'];
    const result = splitAgentDecisions(states.map(state => ({ state })));
    expect(result.skipped.map(row => row.state)).toEqual(['SKIPPED']);
    expect(result.pending.map(row => row.state)).toEqual(states.slice(0, 4));
  });
});
