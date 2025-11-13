// index.js — OrbiDigi EverBee Scraper (final version)
// Express + Playwright + Cheerio + XHR capture + fallback DOM + Docker-ready

const express = require('express');
const cheerio = require('cheerio');
const { chromium } = require('playwright');

const app = express();
const port = process.env.PORT || 10000;

/* ====== ENV ====== */
const EVERBEE_COOKIES  = (process.env.EVERBEE_COOKIES || '').trim();
const STEALTH_ON       = (process.env.STEALTH_ON || '1') !== '0';
const MAX_RETRIES      = parseInt(process.env.MAX_RETRIES || '3', 10);
const RECYCLE_AFTER    = parseInt(process.env.RECYCLE_AFTER || '6', 10);

/* ====== BASE ====== */
const EVERBEE = 'https://app.everbee.io';
const ETSY    = 'https://www.etsy.com';

/* ====== RUNTIME ====== */
let browser = null, context = null, consecutiveErrors = 0;

/* ====== UTILS ====== */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand  = (a,b)=> Math.floor(Math.random()*(b-a+1))+a;
const jitter= ()=> STEALTH_ON ? sleep(rand(250,700)) : Promise.resolve();
const toInt = v => (v==null) ? 0 : (typeof v==='number'? v|0 : (String(v).replace(/[^\d]/g,'')|0));
const score = (vol, comp)=> toInt(vol) / (toInt(comp)+1);
const dedupeBy = (arr, keyFn)=> {
  const seen = new Set();
  return arr.filter(x=>{ const k=keyFn(x); if(seen.has(k)) return false; seen.add(k); return true;});
};
function cookiesFromString(str){
  return str.split(';').map(s=>s.trim()).filter(Boolean).map(p=>{
    const i=p.indexOf('=');
    if (i<=0) return null;
    return { name:p.slice(0,i).trim(), value:p.slice(i+1).trim(), path:'/', secure:true, httpOnly:false, sameSite:'None' };
  }).filter(Boolean);
}

/* ====== BROWSER MANAGEMENT ====== */
async function recycle(reason='stale'){
  try{ if(context) await context.close().catch(()=>{}); }catch{}
  try{ if(browser) await browser.close().catch(()=>{}); }catch{}
  browser=context=null; consecutiveErrors=0;
  console.warn('[recycle]', reason);
}

async function ensureBrowser(){
  if (browser && context) return;
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const ctxOpts = {
    baseURL: EVERBEE,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    locale: 'en-US',
    extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' }
  };

  context = await browser.newContext(ctxOpts);

  if (EVERBEE_COOKIES){
    const parsed = cookiesFromString(EVERBEE_COOKIES);
    const targets = [
      { domain: 'app.everbee.io' }, { domain: '.everbee.io' },
      { domain: 'www.etsy.com' }, { domain: '.etsy.com' }
    ];
    const all = [];
    for (const c of parsed) for (const t of targets) all.push({...c, ...t});
    try { await context.addCookies(all); } catch (e) {
      console.error('addCookies:', e.message);
    }
  }
}

async function openAndIdle(page, url){
  await jitter();
  const resp = await page.goto(url, { waitUntil:'domcontentloaded', timeout:60000 });
  await page.waitForLoadState('networkidle', { timeout:60000 }).catch(()=>{});
  await jitter();
  return resp;
}

async function withRetries(fn, label='task'){
  let last;
  for (let i=1;i<=MAX_RETRIES;i++){
    try {
      const r = await fn();
      consecutiveErrors = 0;
      return r;
    } catch (e) {
      last = e; consecutiveErrors++;
      console.warn(`[${label}] retry ${i}/${MAX_RETRIES}`, e.message||e);
      await sleep(rand(600,1400)*i);
      if (consecutiveErrors >= RECYCLE_AFTER) {
        await recycle(label);
        await ensureBrowser();
      }
    }
  }
  throw last;
}

/* ====== CAPTURE XHR ====== */
function findArraysDeep(obj, pred, acc=[]){
  if (!obj || typeof obj!=='object') return acc;
  if (Array.isArray(obj) && obj.some(pred)) acc.push(obj);
  for (const k of Object.keys(obj)) findArraysDeep(obj[k], pred, acc);
  return acc;
}

async function captureJson(page, pred, ms=4000){
  const bag=[];
  const handler = async (r)=>{
    try{
      const ct = (r.headers()['content-type']||'').toLowerCase();
      if (!ct.includes('application/json')) return;
      const t = await r.text();
      const j = JSON.parse(t);
      const arrs = findArraysDeep(j, pred);
      if (arrs.length) bag.push({ json:j, arrays:arrs });
    }catch{}
  };
  page.on('response', handler);
  await page.waitForTimeout(ms);
  page.off('response', handler);
  return bag;
}

/* ====== PARSERS ====== */
function parseTableRows(html, colMap){
  const $=cheerio.load(html), out=[];
  $('table tbody tr').each((_,tr)=>{
    const td=$(tr).find('td'); if (!td.length) return;
    const row={};
    for (const [prop, idx] of Object.entries(colMap)){
      row[prop]=(td[idx] ? $(td[idx]).text().trim() : '');
    }
    out.push(row);
  });
  return out;
}

/* ====== HEALTH & DIAG ====== */
app.get('/healthz', (_req,res)=> res.json({ ok:true, service:'everbee-scraper', stealth:STEALTH_ON }));

app.get('/diag/browser-check', async (_req,res)=>{
  try {
    const b = await chromium.launch({ headless:true, args:['--no-sandbox','--disable-dev-shm-usage'] });
    const ctx = await b.newContext();
    const p = await ctx.newPage();
    await p.goto('https://example.com', {waitUntil:'domcontentloaded'});
    const ua = await p.evaluate(()=>navigator.userAgent);
    await b.close();
    res.json({ ok:true, userAgent: ua });
  } catch(e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

/* ====== ENDPOINTS ====== */

/* 1️⃣ Keyword Research */
app.get('/everbee/keyword-research', async (req,res)=>{
  const q=(req.query.q||'').toString().trim();
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit||'30',10)));
  try {
    const out = await withRetries(async ()=>{
      await ensureBrowser();
      const p = await context.newPage();
      await openAndIdle(p, `${EVERBEE}/keyword-research`);

      const cap = await captureJson(p, o =>
        o && typeof o==='object' && ('keyword' in o || 'term' in o),
        7000
      );

      let rows=[];
      for (const h of cap) for (const arr of h.arrays) for (const o of arr){
        const keyword=(o.keyword||o.term||'').toString().trim();
        const volume =(o.volume||o.searches||o.avg_searches||'').toString().trim();
        const comp   =(o.competition||o.keyword_competition||o.etsy_competition||'').toString().trim();
        if (keyword) rows.push({ keyword, volume, competition:comp, score:score(volume,comp) });
      }

      if (!rows.length){
        const html = await p.content();
        const dom  = parseTableRows(html, { keyword:0, volume:1, competition:2 });
        rows = dom.map(r=>({...r,score:score(r.volume,r.competition)}));
      }

      await p.close();
      rows = dedupeBy(rows, r=>r.keyword.toLowerCase()).sort((a,b)=>b.score-a.score).slice(0,limit);
      return { query:q, count:rows.length, results:rows };
    }, 'everbee-keyword-research');
    res.json(out);
  } catch(e){ res.status(500).json({ error:e.message||String(e) }); }
});

/* 2️⃣ Product Analytics */
app.get('/everbee/product-analytics', async (req,res)=>{
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit||'20',10)));
  try {
    const out = await withRetries(async ()=>{
      await ensureBrowser();
      const p = await context.newPage();
      await openAndIdle(p, `${EVERBEE}/product-analytics`);

      const cap = await captureJson(p, o =>
        o && typeof o==='object' &&
        ('product' in o || 'title' in o) &&
        ('revenue' in o || 'sales' in o || 'views' in o),
        8000
      );

      let items=[];
      for (const h of cap) for (const arr of h.arrays) for (const o of arr){
        const product=(o.product||o.title||'').toString().trim();
        const shop   =(o.shop_name||o.shop||'').toString().trim();
        const price  =(o.price||'').toString().trim();
        const sales  = toInt(o.sales||o.total_sales);
        const revenue=(o.revenue||'').toString().trim();
        const views  = toInt(o.views||o.total_views);
        if (product) items.push({ product, shop, price, sales, revenue, views });
      }

      if (!items.length){
        const html = await p.content();
        const dom  = parseTableRows(html, { product:0, shop:1, price:2, sales:4, revenue:5 });
        items = dom;
      }

      await p.close();
      return { count:items.length, results:items.slice(0,limit) };
    }, 'everbee-product-analytics');
    res.json(out);
  } catch(e){ res.status(500).json({ error:e.message||String(e) }); }
});

/* 3️⃣ Shop Analyzer */
app.get('/everbee/shop-analyzer', async (req,res)=>{
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit||'20',10)));
  try {
    const out = await withRetries(async ()=>{
      await ensureBrowser();
      const p = await context.newPage();
      await openAndIdle(p, `${EVERBEE}/shop-analyzer`);

      const cap = await captureJson(p, o =>
        o && typeof o==='object' && ('shop_name' in o || 'shop' in o),
        8000
      );

      let shops=[];
      for (const h of cap) for (const arr of h.arrays) for (const o of arr){
        const name =(o.shop_name||o.shop||'').toString().trim();
        const total_sales   = toInt(o.total_sales);
        const total_revenue = (o.total_revenue||'').toString().trim();
        const favorites     = toInt(o.favorites||o.total_favorites);
        const reviews       = toInt(o.reviews||o.total_reviews);
        const currency      = (o.currency||'').toString().trim();
        const location      = (o.location||'').toString().trim();
        const active_listings  = toInt(o.active_listings);
        const digital_listings = toInt(o.digital_listings);
        if (name) shops.push({ name, total_sales, total_revenue, favorites, reviews, currency, location, active_listings, digital_listings });
      }

      if (!shops.length){
        const html = await p.content();
        const dom  = parseTableRows(html, { name:0, total_sales:1, total_revenue:2, favorites:3, reviews:4, location:5 });
        shops = dom;
      }

      await p.close();
      return { count:shops.length, results:shops.slice(0,limit) };
    }, 'everbee-shop-analyzer');
    res.json(out);
  } catch(e){ res.status(500).json({ error:e.message||String(e) }); }
});

/* 4️⃣ My Shop */
app.get('/everbee/my-shop', async (_req,res)=>{
  try {
    const out = await withRetries(async ()=>{
      await ensureBrowser();
      const p = await context.newPage();
      await openAndIdle(p, `${EVERBEE}/my-shop`);

      const cap = await captureJson(p, o =>
        o && typeof o==='object' && ('sales' in o || 'revenue' in o || 'listing_count' in o),
        6000
      );

      const stats={};
      for (const h of cap) for (const arr of h.arrays) for (const o of arr){
        const keys=['sales','revenue','lifetime','avg_price','listing_count','review_rate'];
        for (const k of keys){ if (o[k]!=null && stats[k]==null) stats[k]=o[k]; }
      }

      if (!Object.keys(stats).length){
        const html=await p.content(); const $=cheerio.load(html);
        const body=$('body').text();
        const match=(rx)=> (rx.exec(body)?.[1]||'').trim();
        stats.sales   = stats.sales   || match(/Sales[^0-9]*([\d,\.]+)/i);
        stats.revenue = stats.revenue || match(/Revenue[^0-9$]*(\$?[\d,\.]+)/i);
        stats.listings= stats.listings|| match(/Listings[^0-9]*([\d,\.]+)/i);
      }

      await p.close();
      return { stats };
    }, 'everbee-my-shop');
    res.json(out);
  } catch(e){ res.status(500).json({ error:e.message||String(e) }); }
});

/* ====== START ====== */
app.listen(port, ()=> console.log(`[everbee] listening on :${port}`));
