// iPhone 393x852 @3x end-to-end run against a local worker (wrangler dev on :8787 + mock upstream) and the app on :8765.
// Run from a folder with playwright installed: node app-e2e.playwright.js  (writes shots/09-welcome.png, shots/10-settings-access.png)
const { chromium } = require('playwright');
const assert = require('assert');
const APP = 'http://localhost:8765/', SRV = 'http://localhost:8787';
const SHOTS = '/workspace/moirai-app/shots/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch();
  const mk = async () => {
    const ctx = await b.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
    const page = await ctx.newPage(); const log = { errs: [], reqs: [] };
    page.on('console', m => { if (m.type() === 'error') log.errs.push(m.text()); });
    page.on('pageerror', e => log.errs.push('PAGEERROR ' + e.message));
    page.on('request', r => { if (!r.url().startsWith(APP)) log.reqs.push({ m: r.method(), u: r.url(), code: r.headers()['x-moirai-code'] }); });
    await ctx.route(/api\.(openai\.com|anthropic\.com|x\.ai)/, r => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: r.request().url().includes('anthropic') ? JSON.stringify({ content: [{ text: 'direct claude' }] }) : JSON.stringify({ choices: [{ message: { content: 'direct ' + (r.request().url().includes('x.ai') ? 'grok' : 'gpt') } }] }) }));
    return { ctx, page, log };
  };
  const toastText = p => p.$eval('#toast', t => t.textContent);
  const vis = (p, sel) => p.$eval(sel, e => !e.hidden && getComputedStyle(e).display !== 'none');

  // 1. first run -> welcome
  let { ctx, page, log } = await mk();
  await page.goto(APP + '?server=' + encodeURIComponent(SRV), { waitUntil: 'networkidle' });
  assert.ok(await vis(page, '#welcome'), 'welcome visible on first run');
  assert.equal(await page.evaluate(() => location.search), '', '?server stripped');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('moirai-server'))), SRV);
  await sleep(700);
  await page.screenshot({ path: SHOTS + '09-welcome.png' });
  console.log('✓ welcome shown, ?server= stored + stripped, screenshot 09');

  // 2. wrong code then right code
  await page.fill('#wCode', 'nope'); await page.click('#wGo'); await page.waitForFunction(() => document.querySelector('#wErr').textContent);
  console.log('  wrong code msg:', await page.textContent('#wErr'));
  assert.ok(await vis(page, '#welcome'));
  await page.fill('#wCode', 'TEST-CODE-1'); await page.click('#wGo');
  await page.waitForFunction(() => document.querySelector('#welcome').hidden);
  console.log('✓ code accepted; toast:', await toastText(page));
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('moirai-access')).code), 'TEST-CODE-1');

  // 3. ask all three through the worker
  await page.fill('#q', 'Is the thread of fate fixed?'); await page.click('#ask');
  await page.waitForFunction(() => ['gpt', 'claude', 'grok'].every(id => document.getElementById(id).value), null, { timeout: 10000 });
  const vals = await page.evaluate(() => ['gpt', 'claude', 'grok'].map(id => document.getElementById(id).value.slice(0, 50)));
  console.log('✓ ask all three via worker:', vals);
  const asks = log.reqs.filter(r => r.u === SRV + '/ask' && r.m === 'POST');
  assert.equal(asks.length, 3); assert.ok(asks.every(r => r.code === 'TEST-CODE-1'));
  assert.ok(!log.reqs.some(r => /openai|anthropic|x\.ai/.test(r.u)), 'no direct provider calls in code mode');
  // 4. check each other
  await page.click('#openMore'); await page.click('#checkBtn');
  await page.waitForFunction(() => ['gpt', 'claude', 'grok'].every(id => { const t = document.getElementById(id + 'Crit').textContent; return t && t !== 'Checking…'; }), null, { timeout: 10000 });
  console.log('✓ check each other via worker:', await page.$eval('#claudeCrit', e => e.textContent.slice(0, 60)));
  assert.equal(log.reqs.filter(r => r.u === SRV + '/ask').length, 6 + 0 /* POSTs only; preflights are OPTIONS */ + log.reqs.filter(r => r.u === SRV + '/ask' && r.m === 'OPTIONS').length);

  // 5. settings layout
  await page.waitForFunction(() => !document.querySelector('#toast').classList.contains('show'), null, { timeout: 8000 });
  await page.click('#openSettings'); await page.waitForFunction(() => /Connected/.test(document.querySelector('#accText').textContent));
  await sleep(500);
  const order = await page.$$eval('#settingsSheet .sheet-body > *', els => els.map(e => (e.querySelector('legend,summary') || e).textContent.trim().slice(0, 28)));
  console.log('  settings order:', order);
  assert.ok(order[0].startsWith('Access') && order[1].startsWith('Own API keys') && order[2].startsWith('App icon'));
  assert.equal(await page.$eval('#keysWrap', d => d.open), false, 'keys collapsed');
  console.log('  access status:', await page.textContent('#accText'));
  await page.screenshot({ path: SHOTS + '10-settings-access.png' });
  console.log('✓ settings layout, screenshot 10');
  await page.click('#keysWrap summary'); await sleep(300);
  assert.equal(await page.$eval('#keysWrap', d => d.open), true);
  await page.screenshot({ path: '/tmp/settings-keys-open.png' });
  await page.click('#keysWrap summary');
  // copy invite link
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:8765' });
  await page.click('#accShare'); await sleep(200);
  console.log('  invite link:', await page.evaluate(() => navigator.clipboard.readText()), '| toast:', await toastText(page));
  await page.click('#settingsSheet [data-close]'); await sleep(300);

  // 6. daily limit (8): used 6, two singles ok, third -> 429
  for (let i = 0; i < 3; i++) { await page.click('[data-ask="gpt"]'); await page.waitForFunction(() => !document.querySelector('#panel-gpt').classList.contains('busy')); await sleep(150); }
  console.log('✓ limit: err=', await page.textContent('#gptErr'), '| toast=', await toastText(page));
  assert.match(await page.textContent('#gptErr'), /Daily limit/);
  await page.screenshot({ path: '/tmp/limit.png' });
  console.log('  errors:', log.errs.filter(e => !/429|Failed to load resource/.test(e)));
  await ctx.close();

  // 7. share link ?code=
  ({ ctx, page, log } = await mk());
  await page.goto(APP + '?server=' + encodeURIComponent(SRV) + '&code=friend-2', { waitUntil: 'networkidle' }); await sleep(400);
  assert.equal(await vis(page, '#welcome'), false, 'no welcome via share link');
  assert.equal(await page.evaluate(() => location.href), APP, 'code stripped from URL');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('moirai-access')).code), 'friend-2');
  console.log('✓ ?code= link: url', await page.evaluate(() => location.href), '| toast:', await toastText(page));
  await page.fill('#q', 'Share link test'); await page.click('#ask');
  await page.waitForFunction(() => ['gpt', 'claude', 'grok'].every(id => document.getElementById(id).value), null, { timeout: 10000 });
  console.log('✓ ask all three works after link');
  await page.click('#openSettings'); await sleep(400); console.log('  field:', await page.inputValue('#accessCode'), '|', await page.textContent('#accText'));
  await ctx.close();

  // 8. bad share link
  ({ ctx, page, log } = await mk());
  await page.goto(APP + '?server=' + encodeURIComponent(SRV) + '&code=bogus', { waitUntil: 'networkidle' }); await sleep(400);
  assert.ok(await vis(page, '#welcome')); console.log('✓ bad ?code= -> welcome:', await page.textContent('#wErr'), '| prefilled:', await page.inputValue('#wCode'));
  await ctx.close();

  // 9. server down
  ({ ctx, page, log } = await mk());
  await page.addInitScript(() => { if (!localStorage.getItem('moirai-access')) localStorage.setItem('moirai-access', JSON.stringify({ code: 'TEST-CODE-1' })); });
  await page.goto(APP + '?server=' + encodeURIComponent('http://localhost:8790'), { waitUntil: 'networkidle' });
  await page.fill('#q', 'down?'); await page.click('[data-ask="claude"]');
  await page.waitForFunction(() => document.querySelector('#claudeErr').textContent);
  console.log('✓ server down:', await page.textContent('#claudeErr'), '| toast:', await toastText(page));
  await ctx.close();

  // 10. placeholder SERVER_URL (no override) -> not set up
  ({ ctx, page, log } = await mk());
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.fill('#wCode', 'TEST-CODE-1'); await page.click('#wGo'); await page.waitForFunction(() => document.querySelector('#wErr').textContent);
  console.log('✓ placeholder server:', await page.textContent('#wErr'));
  // 11. own keys link -> settings with keys open, direct calls
  await page.click('#wOwn'); await sleep(700);
  assert.ok(await page.$eval('#settingsSheet', s => s.classList.contains('open'))); assert.ok(await page.$eval('#keysWrap', d => d.open));
  await page.screenshot({ path: '/tmp/own-keys.png' });
  await page.fill('#openaiKey', 'sk-test'); await page.fill('#anthropicKey', 'sk-ant'); await page.fill('#xaiKey', 'xai-t');
  console.log('  keys count:', await page.textContent('#keysCount'));
  await page.click('#settingsSheet [data-close]'); await sleep(300);
  await page.fill('#q', 'own keys'); await page.click('#ask');
  await page.waitForFunction(() => ['gpt', 'claude', 'grok'].every(id => document.getElementById(id).value));
  console.log('✓ own keys direct:', await page.evaluate(() => ['gpt', 'claude', 'grok'].map(id => document.getElementById(id).value)), log.reqs.filter(r => r.m === 'POST').map(r => r.u));
  await page.reload({ waitUntil: 'networkidle' }); assert.equal(await vis(page, '#welcome'), false, 'welcome not shown again');
  console.log('  errors:', log.errs);
  await b.close(); console.log('ALL OK');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
