/** Browser integration regression with controlled API fixtures; never writes real research data. */
import { chromium, baseUrl, outputDir, launchOptions } from './workbench-harness.mjs';
import assert from 'node:assert/strict';
const b=await chromium.launch(launchOptions);
try {
const p=await b.newPage({viewport:{width:1280,height:900}});p.setDefaultTimeout(10000);const errors=[],calls=[];p.on('pageerror',e=>errors.push(e.message));
let authed=false, failMessage=true, status='running', card=false;const now=Date.now();let payload;
const run={id:'edge-run',product:'perp',symbol:'BTCUSDT',marketType:'usdm_perp',horizon:'1h',asOf:now,createdAt:now};
await p.route('**/api/**',async route=>{
const req=route.request(),u=new URL(req.url()),path=u.pathname,method=req.method();let body;try{body=req.postDataJSON()}catch{}calls.push({path,method,body});
const json=(x,s=200)=>route.fulfill({status:s,contentType:'application/json',body:JSON.stringify(x)});
if(path==='/api/auth/me')return json(authed?{user:{username:'edge-user',role:'user'}}:{message:'未登录'},authed?200:401);
if(path==='/api/auth/login'){authed=true;return json({user:{username:'edge-user',role:'user'}})}
if(path==='/api/auth/logout'){authed=false;return json({ok:true})}
if(path==='/api/alerts/history')return json({history:[]});
if(path==='/api/portfolio')return json({positions:[{id:'pos-old',symbol:'BTCUSDT',side:'long',qty:'0.01',entryPrice:'60000',isStale:true}]});
if(path==='/api/event-quotes')return json({quotes:[]});
if(path==='/api/conversations'&&method==='GET')return json({conversations:[]});
if(path==='/api/conversations'&&method==='POST')return json({conversation:{id:'edge-conv'}},201);
if(path.endsWith('/context')){payload=body;return json({confirmedPositionId:'pos-confirmed'})}
if(path.endsWith('/messages')&&method==='POST'){
 if(failMessage)return json({message:'测试：消息服务暂不可用'},503);
 if(card)return json({message:{content:'请核对持仓草稿',runId:null,card:{kind:'confirm_position',draft:{symbol:'BTCUSDT',side:'long',qty:'0.01',entryPrice:'60000',leverage:10,marginMode:'isolated',riskBudget:'200'},complete:true,missingFields:[]}}},202);
 return json({message:{content:'研究中',runId:'edge-run',card:null},runId:'edge-run'},202);
}
if(path.endsWith('/messages'))return json({messages:[]});
if(path.endsWith('/result'))return json({message:'未发布'},409);
if(path.endsWith('/events'))return route.fulfill({contentType:'text/event-stream',body:'id: 1\nevent: step_started\ndata: '+JSON.stringify({step:'retrieve',at:now})+'\n\n'});
if(path.endsWith('/cancel')){status='cancelled';return json({ok:true})}
if(path.endsWith('/evidence'))return json({message:'测试：证据读取失败'},503);
if(path.startsWith('/api/research/runs/'))return json({run:{...run,status},steps:[{step:'retrieve',status:'running'}]});
return json({});
});
await p.goto(baseUrl + '/research?ui=dev');await p.getByRole('heading',{name:/你的比特币/}).waitFor();
assert.deepEqual(calls.map(c=>c.path),['/api/auth/me']);
await p.getByRole('tab',{name:'事件合约'}).click();await p.getByRole('textbox',{name:'研究问题'}).fill('guest event draft');await p.getByLabel('交易对',{exact:true}).fill('ETHUSDT');await p.getByLabel('研究期限',{exact:true}).selectOption('30m');
await p.getByRole('button',{name:'登录后发起研究'}).click();await p.getByRole('link',{name:'联系管理员开通'}).click();assert.match(p.url(),/ui=dev/);
await p.getByRole('link',{name:/返回登录/}).click();assert.match(p.url(),/returnTo=/);
await p.getByRole('textbox',{name:'用户名'}).fill('edge-user');await p.getByLabel('密码',{exact:true}).fill('test-only');await p.locator('button[type=submit]').click();
await p.getByRole('textbox',{name:'研究问题'}).waitFor();assert.match(p.url(),/research\?ui=dev/);assert.equal(await p.getByRole('textbox',{name:'研究问题'}).inputValue(),'guest event draft');assert.equal(await p.getByLabel('交易对',{exact:true}).inputValue(),'ETHUSDT');assert.equal(await p.getByLabel('研究期限',{exact:true}).inputValue(),'30m');assert.equal(await p.getByRole('tab',{name:'事件合约'}).getAttribute('aria-selected'),'true');
await p.getByRole('tab',{name:'事件合约'}).focus();await p.keyboard.press('Home');assert.equal(await p.getByRole('tab',{name:'现货研究'}).getAttribute('aria-selected'),'true');await p.keyboard.press('End');assert.equal(await p.getByRole('tab',{name:'事件合约'}).getAttribute('aria-selected'),'true');
await p.getByRole('button',{name:'发送研究问题'}).click();await p.getByText('出错了：测试：消息服务暂不可用').waitFor();assert.equal(await p.getByRole('textbox',{name:'研究问题'}).inputValue(),'guest event draft');assert.equal(payload.product,'event');assert.equal(payload.marketType,'usdm_perp');assert.equal(payload.quoteId,'');assert.equal(payload.positionId,'');
failMessage=false;await p.getByRole('button',{name:'发送研究问题'}).click();await p.getByRole('button',{name:'取消',exact:true}).waitFor();assert(await p.getByRole('tab',{name:'现货研究'}).isDisabled());await p.getByRole('button',{name:'查看证据 ↗'}).click();await p.getByText('测试：证据读取失败',{exact:true}).waitFor();await p.getByRole('button',{name:'关闭研究资料'}).click();
await p.getByRole('button',{name:'取消',exact:true}).click();await p.locator('.st-cancelled').waitFor({timeout:12000});assert(!await p.getByRole('tab',{name:'现货研究'}).isDisabled());
await p.getByRole('button',{name:'开启新对话'}).click();await p.getByRole('tab',{name:'USDT 永续'}).click();await p.getByLabel('交易对',{exact:true}).fill('BTCUSDT');await p.getByRole('button',{name:'持仓 / 风险'}).click();await p.getByRole('combobox',{name:'关联记录'}).selectOption('pos-old');await p.getByRole('button',{name:'完成，返回对话'}).click();
await p.getByRole('tab',{name:'现货研究'}).click();await p.getByRole('textbox',{name:'研究问题'}).fill('spot question');card=true;
await p.getByRole('button',{name:'发送研究问题'}).click();await p.getByText('请核对持仓草稿',{exact:true}).waitFor();assert.equal(payload.product,'teaching');assert.equal(payload.marketType,'spot');assert.equal(payload.positionId,'');assert.equal(payload.quoteId,'');
await p.getByRole('button',{name:'确认写入持仓'}).click();await p.getByText(/持仓已确认写入/).waitFor();assert.equal(payload.confirm,true);assert.equal(payload.positionDraft.symbol,'BTCUSDT');
await p.getByRole('button',{name:'退出登录'}).click();await p.getByRole('heading',{name:/你的比特币/}).waitFor();assert.match(p.url(),/ui=dev/);assert.equal(await p.getByText('请核对持仓草稿',{exact:true}).count(),0);assert.equal(await p.getByRole('textbox',{name:'研究问题'}).inputValue(),'');
console.log(JSON.stringify({passed:['guest no private requests','auth/register return + scene/symbol/horizon draft','send failure restores draft','event/spot mapping and reference clearing','running context lock','evidence error visible','cancel via poll terminal','position association tool','confirmation PATCH','logout clears private content/mode retained'],errors}));if(errors.length)process.exitCode=1;

} finally { await b.close() }
