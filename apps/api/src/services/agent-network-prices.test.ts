import {afterEach,expect,it,vi} from 'vitest';
vi.mock('../lib/env.js',()=>({env:{OKX_API_KEY:'fixture',OKX_API_SECRET:'fixture',OKX_PASSPHRASE:'fixture'}}));
vi.mock('../lib/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),debug:vi.fn(),error:vi.fn()}}));
vi.mock('./okx-usage.js',()=>({canSpendOkxCall:()=>({allow:true,slow:false}),recordOkxCall:vi.fn()}));
const {fetchLivePrices,setOkxMarketChainIndexes}=await import('./okx-market.js');
afterEach(()=>{vi.unstubAllGlobals();setOkxMarketChainIndexes(null);});
it('official Market price: Solana 501, BNB 56, Robinhood 4663 with EVM normalization and positive prices',async()=>{
 setOkxMarketChainIndexes(['501','56','4663']);
 const items=[{chainIndex:'501',tokenContractAddress:'SoLaNaMint',price:'1.25',time:String(Date.now())},{chainIndex:'56',tokenContractAddress:'0xabcdef',price:'2.50',time:String(Date.now())},{chainIndex:'4663',tokenContractAddress:'0xcompany',price:'0.0000311469178641562',time:String(Date.now())}];
 const fetchMock=vi.fn(async()=>new Response(JSON.stringify({code:'0',data:items}),{status:200}));vi.stubGlobal('fetch',fetchMock);
 const result=await fetchLivePrices([{chain:'SOLANA',address:'SoLaNaMint'},{chain:'BNB',address:'0xABCDEF'},{chain:'ROBINHOOD',address:'0xCOMPANY'}]);
 expect(fetchMock).toHaveBeenCalledTimes(1);
 const [url,init]=fetchMock.mock.calls[0] as unknown as [string,RequestInit];
 expect(url).toBe('https://web3.okx.com/api/v6/dex/market/price');
 expect(JSON.parse(init.body as string)).toEqual(items.map(({chainIndex,tokenContractAddress})=>({chainIndex,tokenContractAddress})));
 expect(result.prices.size).toBe(3);for(const value of result.prices.values())expect(value.priceUsd).toBeGreaterThan(0);
});
