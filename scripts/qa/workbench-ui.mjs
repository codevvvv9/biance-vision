/** Browser integration regression with controlled API fixtures; never writes real research data. */
import { chromium, baseUrl, outputDir, launchOptions } from './workbench-harness.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
const context=await browser.newContext({viewport:{width:1440,height:960}});
const page=await context.newPage(); page.setDefaultTimeout(10000); 
const errors=[], calls=[], events=[];let published=false, created=0, messages=0;
page.on('pageerror',e=>errors.push(e.message));
const now=Date.now();
const run=(id,status='published')=>({id,status,product:id==='run-old'?'teaching':'perp',symbol:id==='run-old'?'ETHUSDT':'BTCUSDT',marketType:id==='run-old'?'spot':'usdm_perp',horizon:id==='run-old'?'1d':'1h',asOf:now-300000,createdAt:now-300000,snapshotId:'snapshot-'+id,ruleVersion:'rules-1',configVersion:'cfg-1'});
const result=id=>({schemaVersion:2,decision:'wait',side:null,probability:null,unavailableCode:'model_not_published',reasons:['等待结构确认'],evidenceQuality:'partial',missingInputs:['未关联持仓'],claims:[{kind:'fact',text:id==='run-old'?'历史 ETH 结构事实':'BTC 结构事实：等待确认，注意反证。',evidenceIds:[id==='run-old'?'e-old':'e-new']},{kind:'interpretation',text:'需要观察下一根已收盘 K 线。',evidenceIds:[id==='run-old'?'e-old':'e-new']}],scenarios:[{condition:'结构确认',response:'重新评估',invalidation:'反向突破'}],payload:{kind:'teaching'}});
const oldCtx={product:'teaching',marketType:'spot',symbol:'ETHUSDT',horizon:'1d',positionId:'',quoteId:''};
const list=()=>[{id:'conv-old',title:'ETH 历史结构研究',updatedAt:now-86400000,context:oldCtx},...(created?[{id:'conv-new',title:'BTC 当前结构',updatedAt:now,context:latestContext}]:[])];let latestContext={};
await context.route('**/api/**',async route=>{
 const req=route.request(),u=new URL(req.url()),p=u.pathname,m=req.method();let body=null;try{body=req.postDataJSON()}catch{}calls.push({p,m,body});
 const json=(o,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(o)});
 if(p==='/api/auth/me')return json({user:{username:'ui-fixture',role:'user'}});
 if(p==='/api/auth/logout')return json({ok:true});
 if(p==='/api/alerts/history')return json({history:[]});
 if(p==='/api/conversations'&&m==='GET')return json({conversations:list()});
 if(p==='/api/conversations'&&m==='POST'){created++;return json({conversation:{id:'conv-new'}},201)}
 if(p.endsWith('/context')){latestContext=body;return json({ok:true,confirmedPositionId:'p-new'})}
 if(p==='/api/conversations/conv-new/messages'&&m==='POST'){messages++;return json({message:{content:'已发起研究，下面是本次分析。',runId:'run-new',card:null},runId:'run-new'},202)}
 if(p.endsWith('/messages'))return json({messages:p.includes('conv-old')?[{id:'m1',role:'user',content:'ETH 当前是什么结构？',runId:null,card:null},{id:'m2',role:'assistant',content:'历史研究结果如下。',runId:'run-old',card:null}]:[]});
 if(p==='/api/portfolio')return json({positions:[]});
 if(p==='/api/event-quotes')return json({quotes:[],evaluations:[]});
 if(p.endsWith('/events')){events.push(p);published=true;return route.fulfill({status:200,contentType:'text/event-stream',body:'id: 1\nevent: step_started\ndata: '+JSON.stringify({step:'retrieve',at:now})+'\n\nid: 2\nevent: step_completed\ndata: '+JSON.stringify({step:'retrieve',at:now})+'\n\nid: 3\nevent: run_published\ndata: {}\n\n'})}
 if(p.endsWith('/result')){if(p.includes('run-new')&&!published)return json({message:'尚未发布'},409);return json({result:result(p.includes('run-old')?'run-old':'run-new')})}
 if(p.endsWith('/evidence')){const old=p.includes('run-old');return json({evidence:[{id:old?'e-old':'e-new',kind:'knowledge_chunk',stance:'counter',docTitle:old?'ETH 历史原文':'BTC 结构参考',pageNo:12,figureId:null,sourceTier:'book',text:old?'ETH 独立冻结片段':'BTC 独立冻结片段。'}],structures:[{id:'s1',kind:'二次进场',direction:'long',atTime:now-3600000,knownAtTime:now-2700000,provisional:false,ruleId:'h2',note:'已收盘确认'}]})}
 if(p.endsWith('/candles')||p==='/api/market/candles'){const tf=p.includes('run-old')?3600000:900000;const rows=Array.from({length:140},(_,i)=>({openTime:now-(140-i)*tf,closeTime:now-(139-i)*tf-1,open:60000+i*5,high:60030+i*5,low:59970+i*5,close:60010+i*5,volume:100,isClosed:true}));return json({snapshot:true,candles:rows})}
 if(p==='/api/market/symbols')return json({symbols:['BTCUSDT','ETHUSDT']});
 if(p==='/api/research/runs'&&m==='POST')return json({run:run('run-retry','running')},201);
 if(p==='/api/research/runs')return json({runs:[run('run-old')]});
 if(p.startsWith('/api/research/runs/'))return json({run:run(p.split('/')[4],p.includes('run-new')&&!published?'running':'published'),steps:published?[{step:'retrieve',status:'completed'}]:[]});
 if(p==='/api/ai/settings')return json({enabled:false,configured:false});
 if(p==='/api/ai/memories')return json({memories:[]});
 return json({});
});
await page.goto(baseUrl + '/research?ui=dev');
await page.getByRole('textbox',{name:'研究问题'}).fill('BTC 当前结构如何？');
await page.getByRole('button',{name:'发送研究问题'}).click();
await page.getByText('BTC 结构事实：等待确认，注意反证。',{exact:false}).waitFor();
assert.equal(created,1);assert.equal(messages,1);assert.equal(events.length,1);
assert.equal(latestContext.product,'perp');assert.equal(latestContext.marketType,'usdm_perp');
assert.match(page.url(),/conversation=conv-new/);assert.match(page.url(),/run=run-new/);
await page.getByRole('button',{name:'查看引用 1'}).first().click();
await page.locator('[data-evidence-id="e-new"].selected').waitFor();
await page.getByText('BTC 独立冻结片段。').waitFor();
assert.match(await page.locator('.wb-detail').innerText(),/第 12 页/);
await page.screenshot({path:outputDir + '/authed-citation.png'});
await page.getByRole('button',{name:'定位 二次进场 到 K 线'}).click();
await page.locator('.wb-chart canvas').first().waitFor();
assert(await page.locator('.wb-chart-canvas').evaluate(el => el.querySelector('.brooks-chart-wrap').getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom + 1));
const resize = page.getByRole('separator', {name:'调整研究资料宽度'});
await resize.focus();await page.keyboard.press('ArrowLeft');assert.equal(await resize.getAttribute('aria-valuenow'),'450');
await page.keyboard.press('ArrowRight');

assert(calls.some(c=>c.p==='/api/research/runs/run-new/candles'));
await page.screenshot({path:outputDir + '/authed-chart.png'});
await page.getByRole('button',{name:'关闭研究资料'}).click();
await page.getByRole('tab',{name:'事件合约'}).click();
await page.getByRole('textbox',{name:'研究问题'}).fill('event unsent draft');
await page.getByRole('tab',{name:'现货研究'}).click();
assert.equal(await page.getByRole('textbox',{name:'研究问题'}).inputValue(),'');
await page.getByRole('tab',{name:'事件合约'}).click();
assert.equal(await page.getByRole('textbox',{name:'研究问题'}).inputValue(),'event unsent draft');
assert.equal(await page.getByText('BTC 结构事实：等待确认，注意反证。',{exact:false}).count(),1);
await page.getByRole('button',{name:'ETH 历史结构研究',exact:true}).click();
await page.getByText('ETH 当前是什么结构？',{exact:true}).waitFor();
await page.getByRole('button',{name:/查看这次研究 run-old/}).click();
await page.getByText('历史 ETH 结构事实',{exact:false}).waitFor();
assert.equal(await page.getByLabel('交易对',{exact:true}).inputValue(),'ETHUSDT');
assert.equal(await page.getByRole('combobox',{name:'研究期限'}).inputValue(),'1d');
await page.getByRole('button',{name:'查看引用 1'}).first().click();
await page.getByText('ETH 独立冻结片段').waitFor();
assert.equal(await page.getByText('BTC 独立冻结片段。').count(),0);
await page.getByRole('button',{name:'关闭研究资料'}).click();
await page.getByRole('link',{name:/切换旧版/}).click();
await page.locator('.research-page').waitFor();
assert.match(page.url(),/ui=legacy/);assert.match(page.url(),/conversation=conv-old/);assert.match(page.url(),/run=run-old/);
await page.getByRole('link',{name:/体验新版/}).click();
await page.locator('.workbench').waitFor();
await page.getByText('历史 ETH 结构事实',{exact:false}).waitFor();
assert.equal(created,1);assert.equal(messages,1);assert.equal(events.length,1);
const other = await context.newPage();
await other.goto(baseUrl + '/research?ui=legacy&conversation=conv-old&run=run-old');
await other.locator('.research-page').waitFor();
assert.match(page.url(),/ui=dev/);assert.equal(await page.locator('.workbench').count(),1);
await other.close();
await page.setViewportSize({width:390,height:844});
await page.getByRole('button',{name:'证据',exact:true}).click();
await page.getByRole('dialog',{name:'研究资料'}).waitFor();
await page.keyboard.press('Tab');assert(await page.locator('.wb-detail').evaluate(e=>e.contains(document.activeElement)));
await page.keyboard.press('Escape');assert(await page.getByRole('button',{name:'证据',exact:true}).evaluate(e=>e===document.activeElement));
await page.screenshot({path:outputDir + '/authed-mobile.png'});
await page.getByRole('button',{name:'打开会话导航'}).click();await page.getByRole('button',{name:'开启新对话'}).click();
await page.getByRole('heading',{name:/你的比特币/}).waitFor();
assert(!page.url().includes('conversation='));assert(!page.url().includes('run='));
for(const ui of ['', '?ui=legacy','?ui=invalid']) { await page.goto(baseUrl + '/research'+ui);await page.locator('.research-page').waitFor();assert.equal(await page.locator('.workbench').count(),0) }
console.log(JSON.stringify({passed:['conversation send','scene mappings/drafts','SSE publish single subscription','citation selection/expansion','frozen chart route','history context/run isolation','legacy/dev same run without send','mobile focus/Escape','new conversation','default/invalid mode'],errors,requests:calls.length,created,messages,events}));
if(errors.length)process.exitCode=1;

} finally { await browser.close() }
