// index.js — OrbiDigi EverBee Scraper (DOM-direct, cookies via header) — FINAL

const express = require('express');
const cheerio = require('cheerio');
const { chromium } = require('playwright');

const app = express();
const port = process.env.PORT || 10000;

/* ====== ENV ====== */
const EVERBEE_COOKIES  = (process.env.EVERBEE_COOKIES || '').trim(); // Debe ser: "name=value; name2=value2; ..."
const STEALTH_ON       = (process.env.STEALTH_ON || '1') !== '0';
const MAX_RETRIES      = parseInt(process.env.RECOVERY_MAX_RETRIES || process.env.MAX_RETRIES || '3', 10);
const EVERBEE_BASE     = 'https://app.everbee.io';

let browser = null;
let context = null;
let consecutiveErrors = 0;

/* ====== UTILS ====== */
const sleep  = ms => new Promise(r=>setTimeout(r,ms));
const rand   = (a,b)=>Math.floor(Math.random()*(b-a+1))+a;
const jitter = ()=> STEALTH_ON ? sleep(rand(250,700)) : Promise.resolve();

/* Suma de señales: más volumen y menos competencia => más score */
const toInt = v => {
  if (v == null) return 0;
  if (typeof v === 'number') return Math.floor(v);
  if (typeof v === 'string') {
    const m = v.replace(/,/g,'').match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : 0;
  }
  return 0;
};
const score = (volume, comp)=> {
  const v = toInt(volume);
  const c = toInt(comp);
  return v > 0 ? v / (c + 1) : 0;
};

/* ====== BROWSER / CONTEXT ====== */
async function recycleContext(reason='recycle'){
  try{ if (context) await context.close(); }catch{}
  try{ if (browser) await browser.close(); }catch{}
  browser  = null;
  context  = null;
  consecutiveErrors = 0;
  console.warn('[recycle]', reason);
}

async function ensureContext(){
  if (browser && context) return;

  browser = await chromium.launch({
    headless:true,
    args:['--no-sandbox','--disable-dev-shm-usage']
  });

  const headers = { 'accept-language':'en-US,en;q=0.9' };
  // 👉 metemos aquí la cabecera Cookie tal cual viene de EVERBEE_COOKIES
  if (EVERBEE_COOKIES) {
    headers['cookie'] = EVERBEE_COOKIES;
  }

  context = await browser.newContext({
    baseURL: EVERBEE_BASE,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    extraHTTPHeaders: headers
  });
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
  for (let i=1; i<=MAX_RETRIES; i++){
    try{
      const out = await fn();
      consecutiveErrors = 0;
      return out;
    }catch(e){
      last = e;
      consecutiveErrors++;
      console.warn(`[${label}] retry ${i}/${MAX_RETRIES}`, e.message || e);
      await sleep(500*i);
      if (consecutiveErrors >= 3){
        await recycleContext(`too many errors in ${label}`);
        await ensureContext();
      }
    }
  }
  throw last;
}

/* ====== HEALTH / DEBUG ====== */
app.get('/healthz', (_req,res)=>res.json({ok:true, service:'everbee-scraper', stealth:STEALTH_ON}));

app.get('/diag/browser-check', async (_req,res)=>{
  try{
    const b  = await chromium.launch({ headless:true, args:['--no-sandbox','--disable-dev-shm-usage'] });
    const ctx= await b.newContext();
    const p  = await ctx.newPage();
    await p.goto('https://example.com', {waitUntil:'domcontentloaded'});
    const ua = await p.evaluate(()=>navigator.userAgent);
    await b.close();
    res.json({ok:true, userAgent:ua});
  }catch(e){
    res.status(500).json({ok:false, error:e.message});
  }
});

/* ====== HELPERS DOM ====== */

/** Abre una URL relativa dentro de EverBee con contexto ya autenticado */
async function openEverbee(path){
  await ensureContext();
  const page = await context.newPage();
  await openAndIdle(page, path.startsWith('http') ? path : `${EVERBEE_BASE}${path}`);
  return page;
}

/* ====== 1) KEYWORD RESEARCH ====== */
/**
 * URL: /keyword-research?keyword=planner
 * Columnas: Keyword | Volume | Competition | Score
 */
app.get('/everbee/keyword-research', async (req,res)=>{
  const q     = (req.query.q || '').toString().trim();
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit || '30', 10)));

  try{
    const data = await withRetries(async ()=>{
      const page = await openEverbee(`/keyword-research?keyword=${encodeURIComponent(q)}`);
      await page.waitForSelector('table tbody tr', { timeout: 15000 }).catch(()=>{});
      const rows = await page.$$eval('table tbody tr', trs => trs.map(tr => {
        const tds = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim());
        if (!tds.length) return null;
        return {
          keyword: tds[0] || '',
          volume:  tds[1] || '',
          competition: tds[2] || ''
        };
      }).filter(Boolean));
      await page.close();
      return rows;
    }, 'keywords');

    let results = data.map(r => ({
      keyword: r.keyword,
      volume: r.volume,
      competition: r.competition,
      score: score(r.volume, r.competition)
    }));

    // dedupe por keyword
    const seen = new Set();
    results = results.filter(r=>{
      const k=(r.keyword||'').toLowerCase();
      if(!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    results.sort((a,b)=> b.score - a.score || toInt(b.volume) - toInt(a.volume));
    results = results.slice(0, limit);

    res.json({ query:q, count: results.length, results });
  }catch(e){
    console.error('keywords error:', e);
    res.status(500).json({error: e.message || String(e)});
  }
});

/* ====== 2) PRODUCT ANALYTICS ====== */
/**
 * URL: /product-analytics?search_term=coloring+book
 * Columnas: Product | Shop Name | Price | Sales | Revenue
 */
app.get('/everbee/product-analytics', async (req,res)=>{
  const q     = (req.query.q || '').toString().trim();
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit || '20', 10)));

  try{
    const data = await withRetries(async ()=>{
      const page = await openEverbee(`/product-analytics?search_term=${encodeURIComponent(q)}`);
      await page.waitForSelector('table tbody tr', { timeout: 15000 }).catch(()=>{});
      const rows = await page.$$eval('table tbody tr', trs => trs.map(tr => {
        const tds = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim());
        if (!tds.length) return null;
        return {
          product : tds[0] || '',
          shop    : tds[1] || '',
          price   : tds[2] || '',
          sales   : tds[4] || '',
          revenue : tds[5] || ''
        };
      }).filter(Boolean));
      await page.close();
      return rows;
    }, 'top-products');

    const results = data.slice(0, limit);
    res.json({ query:q, count: results.length, results });
  }catch(e){
    console.error('top-products error:', e);
    res.status(500).json({error:e.message || String(e)});
  }
});

/* ====== 3) SHOP ANALYZER ====== */
/**
 * URL: /shop-analyzer
 * Columnas: Shop Name | Total Sales | Total Revenue | Mo. Sales | Mo. Revenue | Shop Age | Reviews | Total Favorites | Currency | Location | Active Listings | Digital Listings
 */
app.get('/everbee/shop-analyzer', async (req,res)=>{
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit || '20', 10)));

  try{
    const data = await withRetries(async ()=>{
      const page = await openEverbee('/shop-analyzer');
      await page.waitForSelector('table tbody tr', { timeout: 15000 }).catch(()=>{});
      const rows = await page.$$eval('table tbody tr', trs => trs.map(tr=>{
        const tds = Array.from(tr.querySelectorAll('td')).map(td=>td.innerText.trim());
        if (!tds.length) return null;
        return {
          shopName       : tds[0] || '',
          totalSales     : tds[1] || '',
          totalRevenue   : tds[2] || '',
          moSales        : tds[3] || '',
          moRevenue      : tds[4] || '',
          shopAge        : tds[5] || '',
          reviews        : tds[6] || '',
          totalFavorites : tds[7] || '',
          currency       : tds[8] || '',
          location       : tds[9] || '',
          activeListings : tds[10]|| '',
          digitalListings: tds[11]|| ''
        };
      }).filter(Boolean));
      await page.close();
      return rows;
    }, 'shop-analyzer');

    const results = data.slice(0,limit);
    res.json({ count: results.length, results });
  }catch(e){
    console.error('shop-analyzer error:', e);
    res.status(500).json({error:e.message || String(e)});
  }
});

/* ====== 4) MY SHOP (Overview) ====== */
/**
 * URL: /?tabName=Overview
 * Stats: Sales, Revenue, Listings, etc. en cards de la vista Overview.
 */
app.get('/everbee/my-shop', async (_req,res)=>{
  try{
    const stats = await withRetries(async ()=>{
      const page = await openEverbee('/?tabName=Overview');
      await page.waitForTimeout(3000);
      const text = await page.evaluate(()=>document.body.innerText.replace(/\s+/g,' '));
      await page.close();

      const grab = (re) => {
        const m = text.match(re);
        return m ? (m[1] || m[2] || '').trim() : '';
      };

      return {
        sales   : grab(/(Total Sales|Sales)\s*:?[\s]*([\d,\.]+)/i),
        revenue : grab(/(Total Revenue|Revenue)\s*:?[\s]*([\d\.,]+)/i),
        listings: grab(/(Active Listings|Listings)\s*:?[\s]*([\d,\.]+)/i)
      };
    }, 'my-shop');

    res.json({ stats: stats || {} });
  }catch(e){
    console.error('my-shop error:', e);
    res.status(500).json({error:e.message || String(e)});
  }
});

/* ===== START ===== */
app.listen(port, ()=> console.log(`[everbee] listening on :${port}`));
