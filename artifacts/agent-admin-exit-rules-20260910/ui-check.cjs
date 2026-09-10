const {chromium}=require('/Users/myrotec/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('fs'), assert=require('node:assert/strict'),path=require('path');
const root=path.resolve(__dirname,'../..'),src=fs.readFileSync(root+'/apps/web/app/agent/agent-page.test.tsx','utf8');
const makeData=new Function(src.slice(src.indexOf('function data('),src.indexOf('\nconst wallet =')).replace('over: Record<string, unknown> = {}','over = {}')+'; return data;')();
const wallet=new Function('return '+src.slice(src.indexOf('const wallet = ')+15,src.indexOf('\nafterEach')).trim().replace(/;$/,''))();
const fixture=new Function(src.slice(src.indexOf('const walletAssetsFixture'),src.indexOf('const state ='))+';return {assets:walletAssetsFixture(),selections:liveSelectionFixture(),wallets:walletsFixture()};')();
const data=makeData({viewer:{isAdmin:true},wallet,source:{transportMode:'REST_ONLY',socketState:'rest_only',fallbackActive:true,loginVerified:true,subscriptionsVerified:false,lastWsEventAt:null,lastRestSuccessAt:'2026-09-09T00:00:00Z',accessMessage:'Ключу недоступен WebSocket по Market API subscription (60036)',providerDeliveryLatencyMs:192540,agentDecisionLatencyMs:190,nextAccessCheckAt:Date.parse('2026-09-09T01:00:00Z')}});
data.phase4.networks.forEach(n=>{n.available=true;n.signalsConfirmed=true;n.signalBasis='live';n.reasons=[];});
const decisions=[{id:'waiting',tokenId:'token-a',symbol:'Mooncoin',address:'11111111111111111111111111111111',chain:'SOLANA',state:'RECEIVED',decisionCode:'WAITING_FOR_TOKEN_METADATA',strategyLabel:'Baseline $600',signaledAt:'2026-09-09T00:00:00Z',decidedAt:null},{id:'skip',tokenId:'token-b',symbol:'sat',address:'22222222222222222222222222222222',chain:'SOLANA',state:'SKIPPED',decisionCode:'AMOUNT_BELOW_THRESHOLD',strategyLabel:'Baseline $600',signaledAt:'2026-09-09T00:00:00Z',decidedAt:'2026-09-09T00:00:01Z'}];data.recentDecisions=decisions; data.wallet.exitPlan={mode:'TRAILING_PURE',label:'Чистый трейлинг'};data.phase4.controlMode='semi-auto';data.phase4.allowedExitModes=['TARGET'];
const assets={...fixture.assets,totalUsd:'225',lockedUsd:'0',availableUsd:'225',unpricedAssets:0,withdrawalFeeBps:0,assets:[],depositAddresses:[],pendingWithdrawals:[]};
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});const results=[];
 try { for(const width of [390,1280]) {
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});
  await context.addInitScript(()=>{sessionStorage.setItem('accessToken','local-visual-fixture');localStorage.setItem('role','ADMIN');});
  const writes=[];
  await context.route('https://memex-api.onrender.com/**',async route=>{
   const req=route.request();const p=new URL(req.url()).pathname;
   if(req.method()!=='GET'&&req.method()!=='OPTIONS')writes.push({path:p,body:req.postDataJSON()});
   let body={items:[],proposals:[],tokens:[],wallets:[]};
   if(p.endsWith('/access/me'))body={effectivePlan:'PRO',status:'active',capabilities:['agent','radar','semi_auto'],emailVerified:true,serviceAccess:true};
   else if(p.endsWith('/admin/paper-agent'))body={control:data.control,comparison:[]};
   else if(p.endsWith('/paper-agent'))body=data;
   await route.fulfill({json:body});
  });
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:3019/memex-dex/agent/settings/');
  await page.getByRole('button',{name:'Далее',exact:true}).click();
  assert.equal(await page.getByRole('radio').count(),5);
  assert.equal(await page.getByRole('radio',{name:/Чистый трейлинг/}).getAttribute('aria-checked'),'true');
  assert.deepEqual(writes,[]);
  await page.screenshot({path:__dirname+`/screens/admin-paper-exits-${width}.png`,fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
  await page.getByRole('radio',{name:/Лестница/}).click();
  await page.getByRole('button',{name:'Далее',exact:true}).click();
  assert((await page.locator('[data-settings-summary]').innerText()).includes('Лестница'));
  await page.getByRole('button',{name:'Применить',exact:true}).click();
  await page.waitForResponse(r=>r.url().endsWith('/admin/paper-agent/allocation'));
  assert.equal(writes.length,1);assert.equal(writes[0].body.exitMode,'LADDER');
  assert.deepEqual(errors,[]);results.push({width,modes:5,savedTrailingPreserved:true,submittedMode:'LADDER',overflow:false,errors});
  await context.close();
 }}finally{await browser.close();}
 fs.writeFileSync(__dirname+'/ui-results.json',JSON.stringify({fixture:true,productionWrites:false,results},null,2));console.log(JSON.stringify(results));
})().catch(e=>{console.error(e);process.exit(1)});
