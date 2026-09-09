import assert from 'node:assert/strict';
import { isMarketDataSupported, fetchPoolForToken } from '../../apps/api/src/services/market-data.js';
let requests = 0;
globalThis.fetch = async () => { requests++; throw new Error('Network forbidden in local coverage diagnostic'); };
async function main() {
const result = await fetchPoolForToken('ROBINHOOD', '0x0000000000000000000000000000000000000001');
assert.equal(isMarketDataSupported('ROBINHOOD'), false);
assert.equal(result, null);
assert.equal(requests, 0);
console.log(JSON.stringify({ chain: 'ROBINHOOD', supportedByCurrentMetadataAdapter: false, result, actualProviderRequests: requests, finding: 'Current on-demand metadata path cannot obtain a missing Robinhood pool date' }, null, 2));

}
void main();
