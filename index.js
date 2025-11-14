// index.js — OrbiDigi EverBee Scraper (final)
// Express + Playwright + Cheerio + DOM scraping (EverBee) + Docker-ready

const express = require('express');
const cheerio = require('cheerio');
const { chromium } = require('playwright');

const app  = express();
const port = process.env.PORT || 10000;

/* ===== ENV ===== */
const EVERBEE_COOKIES  = (process.env.EVERBEE_COOKIES || '').trim();
const STEALTH_ON       = (process.env.STEALTH_ON || '1') !== '0';
const MAX_RETRIES      = parseInt(process.env.MAX_RETRIES || '3', 10);
const RECYCLE_AFTER    = parseInt(process.env.RECYCLE_AFTER || '6', 10);

/* ===== BASE URLS ===== */
const EVERBEE = 'https://app.everbee.io';
const ETSY    = 'https://www.etsy.com';

/* ===== RUNTIME ===== */
let browser = null, context = null, consecutiveErrors = 0;

/* ===== UTILS ===== */
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const rand   = (a,b)=> Math.floor(Math.random()*(b-a+1))+a;
const jitter = ()=> STEALTH_ON ? sleep(rand(250,700)) : Promise.resolve();
const toInt  = v => (v==null) ? 0 : (typeof v==='number'? v|0 : (String(v).replace(/[^\d]/g,'')|0));
const score  = (vol, comp)=> toInt(vol) / (toInt(comp)+1);
const dedupeBy = (arr, keyFn)=>{
  const seen = new Set();
  return arr.filter(x=>{ const k=keyFn(x); if(seen.has(k)) return false; seen.add(k); return true; });
};
function cookiesFromString(str){
  return str.split(';').map(s=>s.trim()).filter(Boolean).map(p=>{
    const i=p.indexOf('=');
    if (i<=0) return null;
    return {
      name: p.slice(0,i).trim(),
      value: p.slice(i+1).trim(),
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'None'
    };
  }).filter(Boolean);
}

/* ===== BROWSER MANAGEMENT ===== */
async function recycle(reason='stale'){
  try{ if(context) await context.close().catch(()=>{}); }catch{}
  try{ if(browser) await browser.close().catch(()=>{}); }catch{}
  context = null; browser = null; consecutiveErrors = 0;
  console.warn('[recycle]', reason);
}
async function ensureBrowser(){
  if (browser && context) return;
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-dev-shm-usage']
  });
  const ctxOpts = {
    baseURL: EVERBEE,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    locale: 'en-US',
    extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' }
  };
  context = await browser.newContext(ctxOpts);

  if (EVERBEE_COOKIES){
    const parsed  = cookiesFromString(EVERBEE_COOKIES);
    const targets = [
      { domain:'app.everbee.io' }, { domain:'.everbee.io' },
      { domain:'www.etsy.com'   }, { domain:'.etsy.com'    }
    ];
    const all=[];
    for (const c of parsed) for (const t of targets) all.push({ ...c, ...t });
    try{ await context.addCookies(all); }catch(e){ console.error('addCookies:', e.message); }
  }
}
async function openAndIdle(page, url){
  await jitter();
  const resp = await page.goto(url, { waitUntil:'domcontentloaded', timeout:60000 });
  await page.waitForLoadState('networkidle',{timeout:60000}).catch(()=>{});
  await jitter();
  return resp;
}
async function withRetries(fn, label='task'){
  let last;
  for (let i=1;i<=MAX_RETRIES;i++){
    try{
      const r = await fn();
      consecutiveErrors = 0;
      return r;
    }catch(e){
      last = e; consecutiveErrors++;
      console.warn(`[${label}] retry ${i}/${MAX_RETRIES}`, e.message||e);
      await sleep(rand(600,1400)*i);
      if (consecutiveErrors>=RECYCLE_AFTER){
        await recycle(label);
        await ensureBrowser();
      }
    }
  }
  throw last;
}

/* ===== BASIC DOM PARSERS ===== */
function parseTableRows(html, colMap){
  const $=cheerio.load(html), out=[];
  $('table tbody tr').each((_,tr)=>{
    const td=$(tr).find('td'); if(!td.length) return;
    const row={};
    for (const [prop,idx] of Object.entries(colMap)){
      row[prop] = td[idx] ? $(td[idx]).text().trim() : '';
    }
    out.push(row);
  });
  return out;
}
function parseEverbeeKeywords(html){
  const $=cheerio.load(html);
  const tables = $('table');
  let best = null;

  tables.each((_,t)=>{
    const table = $(t);
    const hdrs=[];
    table.find('thead tr').first().find('th,td').each((__,el)=>{
      const t = $(el).text().trim().toLowerCase();
      hdrs.push(t);
    });
    if (!hdrs.length) return;
    const hasKw = hdrs.some(h=>/keyword|key ?word|tag|phrase/.test(h));
    if (!hasKw) return;
    if (!best) best = table;
  });

  const table = best || tables.first();
  if (!table || !table.length) return [];

  const headers=[];
  table.find('thead tr').first().find('th,td').each((_,el)=>headers.push($(el).text().trim().toLowerCase()));
  const idxKey  = headers.findIndex(h => /keyword|key ?word|tag|phrase/.test(h));
  const idxVol  = headers.findIndex(h => /volume|avg.*search|searches|monthly/.test(h));
  const idxComp = headers.findIndex(h => /competit|difficulty|comp/.test(h));

  const rows=[];
  table.find('tbody tr').each((_,tr)=>{
    const td=$(tr).find('td'); if (!td.length) return;
    const cols = td.map((__,el)=>$(el).text().trim()).get();
    const kw  = idxKey  >=0 ? cols[idxKey]  : '';
    const vol = idxVol  >=0 ? cols[idxVol]  : '';
    const cmp = idxComp >=0 ? cols[idxComp] : '';
    if (kw) rows.push({ keyword:kw, volume:vol, competition:cmp, score:score(vol,cmp) });
  });
  return rows;
}

/* ===== HEALTH & DIAG ===== */
app.get('/healthz', (_q,r)=>r.json({ ok:true, service:'everbee-scraper', stealth:STEALTH_ON }));
app.get('/diag/browser-check', async (_q,r)=>{
  try{
    const b  = await chromium.launch({ headless:true, args:['--no-sandbox','--disable-dev-shm-usage'] });
    const ctx= await b.newContext();
    const p  = await ctx.newPage();
    await p.goto('https://example.com',{waitUntil:'domcontentloaded'});
    const ua = await p.evaluate(()=>navigator.userAgent);
    await b.close();
    r.json({ ok:true, userAgent:ua });
  }catch(e){
    r.status(500).json({ ok:false, error:e.message });
  }
});

/* ===== 1) Keyword Research ===== */
/**
 * EverBee URL patrón:
 *  app.everbee.io/keyword-research?keyword=planner
 * usamos ?keyword=<q> y luego parseamos la tabla.
 */
app.get('/everbee/keyword-research', async (req,res)=>{
  const q     = (req.query.q||'').toString().trim();
  const limit = Math.max(1,Math.min(200,parseInt(req.query.limit||'30',10)));
  try{
    const out = await withRetries(async ()=>{
      await ensureBrowser();
      const p = await context.newPage();
      const url = `${EVERBEE}/keyword-research?keyword=${encodeURIComponent(q || '')}`;
      await openAndIdle(p, url);
      await p.waitForTimeout(4000);
      await p.waitForSelector('table tbody tr',{timeout:10000}).catch(()=>{});

      const html = await p.content();
      await p.close();

      let rows = parseEverbeeKeywords(html);
      if (!rows.length){
        rows = parseTableRows(html,{keyword:0, volume:1, competition:2});
        rows = rows.map(r=>({...r,score:score(r.volume,r.competition)}));
      }

      rows = dedupeBy(rows,r=>r.keyword.toLowerCase())
              .sort((a,b)=>b.score-a.score || toInt(b.volume)-toInt(a.volume))
              .slice(0,limit);

      return { query:q, count:rows.length, results:rows };
    }, 'everbee-keyword-research');
    res.json(out);
  }catch(e){ res.status(500).json({ error:e.message||String(e) }); }
});

/* ===== 2) Product Analytics ===== */
/**
 * URL patrón vista en tu captura:
 *  app.everbee.io/product-analytics?search_term=coloring+book
 */
app.get('/everbee/product-analytics', async (req,res)=>{
  const q     = (req.query.q||'').toString().trim();
  const limit = Math.max(1,Math.min(200,parseInt(req.query.limit||'20',10)));
  try{
    const out = await withRetries(async ()=>{
      await ensureBrowser();
      const p = await context.newPage();
      const url = `${EVERBEE}/product-analytics?search_term=${encodeURIComponent(q || '')}`;
      await openAndIdle(p, url);
      await p.waitForTimeout(4000);
      await p.waitForSelector('table tbody tr',{timeout:10000}).catch(()=>{});

      const html = await p.content();
      await p.close();

      // Product | Shop Name | Price | Sales | Revenue | ...
      let items = parseTableRows(html, {
        product:0,
        shop:1,
        price:2,
        sales:4,
        revenue:5
      });

      items = items.map(r=>({
        product: r.product,
        shop   : r.shop,
        price  : r.price,
        sales  : r.sales,
        revenue: r.revenue
      })).slice(0,limit);

      return { query:q, count:items.length, results:items };
    }, 'everbee-product-analytics');
    res.json(out);
  }catch(e){ res.status(500).json({ error:e.message||String(e) }); }
});

/* ===== 3) Shop Analyzer ===== */
/**
 * Vista “Shop Analyzer” sin filtro (o filtrable con q si quieres).
 */
app.get('/everbee/shop-analyzer', async (req,res)=>{
  const q     = (req.query.q||'').toString().trim();
  const limit = Math.max(1,Math.min(200,parseInt(req.query.limit||'20',10)));
  try{
    const out = await withRetries(async ()=>{
      await ensureBrowser();
      const p = await context.newPage();
      const url = `${EVERBEE}/shop-analyzer`;
      await openAndIdle(p, url);
      await p.waitForTimeout(4000);
      await p.waitForSelector('table tbody tr',{timeout:10000}).catch(()=>{});

      const html = await p.content();
      await p.close();

      // Shop Name | Total Sales | Total Revenue | ... | Total Favorites | Currency | Location | Active Listings | Digital Listings
      let shops = parseTableRows(html, {
        name:0,
        total_sales:1,
        total_revenue:2,
        reviews:4,
        favorites:7,
        currency:8,
        location:9,
        active_listings:10,
        digital_listings:11
      });

      shops = shops.slice(0,limit);
      return { query:q, count:shops.length, results:shops };
    }, 'everbee-shop-analyzer');
    res.json(out);
  }catch(e){ res.status(500).json({ error:e.message||String(e) }); }
});

/* ===== 4) My Shop (Overview tab) ===== */
/**
 * URL patrón:
 *  app.everbee.io/?tabName=Overview
 * Stats visibles: Sales, Revenue, Listings + panel de “Other stats”.
 */
app.get('/everbee/my-shop', async (_req,res)=>{
  try{
    const out = await withRetries(async ()=>{
      await ensureBrowser();
      const p = await context.newPage();
      const url = `${EVERBEE}/?tabName=Overview`;
      await openAndIdle(p, url);
      await p.waitForTimeout(3000);

      const html = await p.content();
      await p.close();

      const $   = cheerio.load(html);
      const txt = $('body').text().replace(/\s+/g,' ');

      function grab(re){
        const m = txt.match(re);
        return m ? (m[1] || m[2] || '').trim() : '';
      }

      const stats = {
        sales   : grab(/(Total Sales|Sales)[^0-9]*([\d,\.]+)/i),
        revenue : grab(/(Total Revenue|Revenue)[^0-9$]*(\$?[\d,\.]+)/i),
        listings: grab(/(Listings|Active Listings)[^0-9]*([\d,\.]+)/i)
      };

      return { stats };
    }, 'everbee-my-shop');
    res.json(out);
  }catch(e){ res.status(500).json({ error:e.message||String(e) }); }
});

/* ===== START ===== */
app.listen(port, ()=> console.log(`[everbee] listening on :${port}`));
