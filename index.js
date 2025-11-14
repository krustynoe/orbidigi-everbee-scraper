// index.js — OrbiDigi EverBee Scraper (DOM-direct, final)
// Express + Playwright (Chromium) + scraping directo del DOM EverBee

const express = require('express');
const { chromium } = require('playwright');

const app  = express();
const port = process.env.PORT || 10000;

/* ===== ENV ===== */
const EVERBEE_COOKIES  = (process.env.EVERBEE_COOKIES || '').trim();
const STEALTH_ON       = (process.env.STEALTH_ON || '1') !== '0';
const MAX_RETRIES      = parseInt(process.env.MAX_RETRIES || '3', 10);
const RECYCLE_AFTER    = parseInt(process.env.RECYCLE_AFTER || '6', 10);

/* ===== CONSTANTES ===== */
const EVERBEE = 'https://app.everbee.io';

let browser = null;
let context = null;
let consecutiveErrors = 0;

/* ===== UTILS ===== */
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const rand   = (a,b)=> Math.floor(Math.random()*(b-a+1))+a;
const jitter = ()=> STEALTH_ON ? sleep(rand(250,700)) : Promise.resolve();
const toInt  = v => (v==null) ? 0 : (typeof v==='number'? v|0 : (String(v).replace(/[^\d]/g,'')|0));
const score  = (vol, comp)=> toInt(vol) / (toInt(comp)+1);

function cookiesFromString(str){
  return str.split(';')
    .map(s=>s.trim())
    .filter(Boolean)
    .map(p=>{
      const i=p.indexOf('=');
      if (i<=0) return null;
      return {
        name: p.slice(0,i).trim(),
        value: p.slice(i+1).trim(),
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'None',
        domain: '.everbee.io'
      };
    }).filter(Boolean);
}

/* ===== BROWSER ===== */
async function recycle(reason='stale'){
  try{ if(context) await context.close().catch(()=>{}); }catch{}
  try{ if(browser) await browser.close().catch(()=>{}); }catch{}
  browser = null;
  context = null;
  consecutiveErrors = 0;
  console.warn('[recycle]', reason);
}

async function ensureBrowser(){
  if (browser && context) return;
  browser = await chromium.launch({
    headless:true,
    args:['--no-sandbox','--disable-dev-shm-usage']
  });
  context = await browser.newContext({
    baseURL: EVERBEE,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    locale: 'en-US',
    extraHTTPHeaders: { 'accept-language':'en-US,en;q=0.9' }
  });

  if (EVERBEE_COOKIES){
    const parsed = cookiesFromString(EVERBEE_COOKIES);
    if (parsed.length){
      try{ await context.addCookies(parsed); }catch(e){ console.error('addCookies:', e.message); }
    }
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
  for (let i=1; i<=MAX_RETRIES; i++){
    try{
      const out = await fn();
      consecutiveErrors = 0;
      return out;
    }catch(e){
      last = e;
      consecutiveErrors++;
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

/* ===== HEALTH & DIAG ===== */
app.get('/healthz', (_req,res)=> res.json({ ok:true, service:'everbee-scraper', stealth:STEALTH_ON }));

app.get('/diag/browser-check', async (_req,res)=>{
  try{
    const b  = await chromium.launch({ headless:true, args:['--no-sandbox','--disable-dev-shm-usage'] });
    const ctx= await b.newContext();
    const p  = await ctx.newPage();
    await p.goto('https://example.com',{ waitUntil:'domcontentloaded' });
    const ua = await p.evaluate(()=>navigator.userAgent);
    await b.close();
    res.json({ ok:true, userAgent:ua });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

/* ===== 1) KEYWORD RESEARCH ===== */
/**
 * Vista: app.everbee.io/keyword-research?keyword=planner
 * Columnas: Keyword | Volume | Competition | Keyword Score
 */
app.get('/everbee/keyword-research', async (req,res)=>{
  const q     = (req.query.q||'').toString().trim();
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit||'30',10)));

  try{
    const out = await withRetries(async ()=>{
      await ensureBrowser();
      const p = await context.newPage();
      const url = `${EVERBEE}/keyword-research?keyword=${encodeURIComponent(q || '')}`;
      await openAndIdle(p, url);
      await p.waitForSelector('table tbody tr',{timeout:15000}).catch(()=>{});

      const rows = await p.$$eval('table tbody tr', trs => trs.map(tr=>{
        const tds = Array.from(tr.querySelectorAll('td')).map(td=>td.innerText.trim());
        if (!tds.length) return null;
        return {
          keyword    : tds[0] || '',
          volume     : tds[1] || '',
          competition: tds[2] || '',
          keywordScore: tds[3] || ''
        };
      }).filter(Boolean));

      await p.close();

      let results = rows.map(r=>({
        keyword    : r.keyword,
        volume     : r.volume,
        competition: r.competition,
        score      : score(r.volume, r.competition)
      }));

      // dedupe
      const seen = new Set();
      results = results.filter(r=>{
        const k = (r.keyword||'').toLowerCase();
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      results.sort((a,b)=> b.score - a.score || toInt(b.volume) - toInt(a.volume));
      results = results.slice(0, limit);

      return { query:q, count:results.length, results };
    }, 'everbee-keyword-research');

    res.json(out);
  }catch(e){
    res.status(500).json({ error:e.message || String(e) });
  }
});

/* ===== 2) PRODUCT ANALYTICS ===== */
/**
 * Vista: app.everbee.io/product-analytics?search_term=coloring+book
 * Columnas: Product | Shop Name | Price | Sales | Revenue
 */
app.get('/everbee/product-analytics', async (req,res)=>{
  const q     = (req.query.q||'').toString().trim();
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit||'20',10)));

  try{
    const out = await withRetries(async ()=>{
      await ensureBrowser();
      const p = await context.newPage();
      const url = `${EVERBEE}/product-analytics?search_term=${encodeURIComponent(q || '')}`;
      await openAndIdle(p, url);
      await p.waitForSelector('table tbody tr',{timeout:15000}).catch(()=>{});

      const rows = await p.$$eval('table tbody tr', trs => trs.map(tr=>{
        const tds = Array.from(tr.querySelectorAll('td')).map(td=>td.innerText.trim());
        if (!tds.length) return null;
        return {
          product:   tds[0] || '',
          shopName:  tds[1] || '',
          price:     tds[2] || '',
          sales:     tds[4] || '',
          revenue:   tds[5] || ''
        };
      }).filter(Boolean));

      await p.close();

      const items = rows.slice(0, limit);
      return { query:q, count:items.length, results:items };
    }, 'everbee-product-analytics');

    res.json(out);
  }catch(e){
    res.status(500).json({ error:e.message || String(e) });
  }
});

/* ===== 3) SHOP ANALYZER ===== */
/**
 * Vista: app.everbee.io/shop-analyzer
 * Columnas (según captura):
 * Shop Name | Total Sales | Total Revenue | Mo. Sales | Mo. Revenue | Shop Age | Reviews | Total Favorites | Currency | Location | Active Listings | Digital Listings
 */
app.get('/everbee/shop-analyzer', async (req,res)=>{
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit||'20',10)));

  try{
    const out = await withRetries(async ()=>{
      await ensureBrowser();
      const p = await context.newPage();
      const url = `${EVERBEE}/shop-analyzer`;
      await openAndIdle(p, url);
      await p.waitForSelector('table tbody tr',{timeout:15000}).catch(()=>{});

      const rows = await p.$$eval('table tbody tr', trs => trs.map(tr=>{
        const tds = Array.from(tr.querySelectorAll('td')).map(td=>td.innerText.trim());
        if (!tds.length) return null;
        return {
          shopName      : tds[0] || '',
          totalSales    : tds[1] || '',
          totalRevenue  : tds[2] || '',
          moSales       : tds[3] || '',
          moRevenue     : tds[4] || '',
          shopAge       : tds[5] || '',
          reviews       : tds[6] || '',
          totalFavorites: tds[7] || '',
          currency      : tds[8] || '',
          location      : tds[9] || '',
          activeListings: tds[10]|| '',
          digitalListings:tds[11]|| ''
        };
      }).filter(Boolean));

      await p.close();

      const shops = rows.slice(0, limit);
      return { count:shops.length, results:shops };
    }, 'everbee-shop-analyzer');

    res.json(out);
  }catch(e){
    res.status(500).json({ error:e.message || String(e) });
  }
});

/* ===== 4) MY SHOP (OVERVIEW) ===== */
/**
 * Vista: app.everbee.io/?tabName=Overview
 * Cards de stats: Sales, Revenue, Listings, etc.
 */
app.get('/everbee/my-shop', async (_req,res)=>{
  try{
    const out = await withRetries(async ()=>{
      await ensureBrowser();
      const p   = await context.newPage();
      const url = `${EVERBEE}/?tabName=Overview`;
      await openAndIdle(p, url);
      await p.waitForTimeout(3000);

      const stats = await p.evaluate(()=>{
        const text = document.body.innerText.replace(/\s+/g,' ');
        const grab = (re) => {
          const m = text.match(re);
          return m ? (m[1] || m[2] || '').trim() : '';
        };
        return {
          sales   : grab(/(Total Sales|Sales)[^0-9]*([\d,\.]+)/i),
          revenue : grab(/(Total Revenue|Revenue)[^0-9$]*(\$?[\d,\.]+)/i),
          listings: grab(/(Listings|Active Listings)[^0-9]*([\d,\.]+)/i)
        };
      });

      await p.close();
      return { stats };
    }, 'everbee-my-shop');

    res.json(out);
  }catch(e){
    res.status(500).json({ error:e.message || String(e) });
  }
});

/* ===== START ===== */
app.listen(port, ()=> console.log(`[everbee] listening on :${port}`));
