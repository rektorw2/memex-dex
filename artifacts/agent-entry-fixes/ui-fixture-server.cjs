// Local visual fixture only. Never forwards requests to production.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '../..');
const src = fs.readFileSync(root + '/apps/web/app/agent/agent-page.test.tsx', 'utf8');
const makeData = new Function(src.slice(src.indexOf('function data('), src.indexOf('\nconst wallet =')).replace('over: Record<string, unknown> = {}','over = {}') + ';return data;')();
const wallet = new Function('return ' + src.slice(src.indexOf('const wallet = ') + 15, src.indexOf('\nafterEach')).trim().replace(/;$/,''))();
const data = makeData({wallet,source:{transportMode:'REST_ONLY',socketState:'rest_only',fallbackActive:true,loginVerified:true,subscriptionsVerified:false,lastWsEventAt:null,lastRestSuccessAt:'2026-09-09T02:12:30Z',accessMessage:'Ключу недоступен WebSocket по Market API subscription (60036)',restDelivery:{status:'BUDGET_UNCONFIRMED',roundMs:300000,message:'Бюджет и частота OKX REST не подтверждены. Своевременный вход не обеспечен; требуется восстановить WS или выделить квоту.'},providerDeliveryLatencyMs:192540,agentDecisionLatencyMs:190}});
http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','http://127.0.0.1:3019'); res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type'); res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
  const p=new URL(req.url,'http://localhost').pathname; let body={};
  if(p.endsWith('/auth/login')) body={accessToken:'local-visual-fixture',refreshToken:'local-visual-fixture',role:'USER'};
  else if(p.endsWith('/access/me')) body={effectivePlan:'PRO',status:'active',capabilities:['agent','radar','semi_auto','PORTFOLIO_READ','MANUAL_TRADE'],emailVerified:true,serviceAccess:true,serverTime:'2026-09-09T02:12:30Z'};
  else if(p.endsWith('/paper-agent'))body=data;
  else if(p.endsWith('/health'))body={status:'ok'};
  else body={items:[],proposals:[],tokens:[],wallets:[]};
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));
}).listen(4019,'127.0.0.1');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.webp':'image/webp','.avif':'image/avif'};
http.createServer((req,res)=>{
  let name=decodeURIComponent(new URL(req.url,'http://localhost').pathname); if(name.endsWith('/')) name+='index.html';
  let file=path.resolve(root,'apps/web/out','.'+name);if(!file.startsWith(path.resolve(root,'apps/web/out')+path.sep)){res.writeHead(403);return res.end();}
  if((fs.existsSync(file)&&fs.statSync(file).isDirectory())||(!fs.existsSync(file)&&!path.extname(file)))file+='/index.html';
  if(!fs.existsSync(file)){res.writeHead(404);return res.end('Not found');}
  res.setHeader('Content-Type',mime[path.extname(file)]??'application/octet-stream');fs.createReadStream(file).pipe(res);
}).listen(3019,'127.0.0.1');
console.log('Fixture API 4019; static export 3019. Synthetic data; production is not contacted.');
