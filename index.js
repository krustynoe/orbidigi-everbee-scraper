// index.js — eRank / EverBee scraper (EverBee integrado, cookies vía header)

const express = require('express');
const cheerio = require('cheerio');
const { chromium } = require('playwright');

const app = express();
const port = process.env.PORT || 10000;

/* ============================
   CONFIGURACIÓN GLOBAL
============================ */

const EVERBEE_COOKIES  = (process.env.EVERBEE_COOKIES || '').trim(); // línea completa de "cookie: ..."
const STEALTH_ON       = (process.env.STEALTH_ON || '1') !== '0';
const MAX_RETRIES      = parseInt(process.env.MAX_RETRIES || '3', 10);
const RECYCLE_AFTER    = parseInt(process.env.RECYCLE_AFTER || '6', 10);

const EV_BASE = 'https://app.everbee.io';

let browser = null;
let evContext = null;
let consecutiveErrors = 0;

/* ============================
   UTILIDADES
============================ */

const rand   = (a,b)=>Math.floor(Math.random()*(b-a+1))+a;
const sleep  = ms=>new Promise(r=>setTimeout(r,ms));
const jitter = ()=> STEALTH_ON ? sleep(rand(300,900)) : Promise.resolve();

const toInt = v=>{
  if (v == null) return 0;
  if (typeof v === 'number') return Math.floor(v);
  if (typeof v === 'string') {
    const m = v.replace(/[^\d]/g,'');
    return m ? parseInt(m,10) : 0;
  }
  return 0;
};
const score = (volume, comp)=>{
  const v = toInt(volume);
  const c = toInt(comp);
  return v / (c + 1);
};

async function withRetries(fn, label='task'){
  let last;
  for (let i=1;i<=MAX_RETRIES;i++){
    try {
      const r = await fn();
      consecutiveErrors = 0;
      return r;
    } catch (e) {
      last = e;
      console.warn(`[${label}] fallo intento ${i}/${MAX_RETRIES}: ${e.message||e}`);
      await sleep(rand(700,1500));
      if (++consecutiveErrors >= RECOVERY_LIMIT) {
        await recycleBrowser(`demasiados fallos en ${label}`);
      }
    }
  }
  throw last;
}

/* ============================
   BROWSER / CONTEXTO EVERBEE
============================ */

async function ensureBrowser(){
  if (browser && evContext) return;

  if (browser) {
    try { await browser.close(); } catch {}
  }

  console.log('[browser] Iniciando Chromium...');
  browser = await chromium.launch({
    headless:true,
    args:['--no-sandbox','--disable-dev-shm-usage']
  });

  const headers = {
    'accept-language': 'en-US,en;q=0.9'
  };
    // 🔴 APLICAMOS AQUÍ LA CABECERA Cookie CON TUS COOKIES DE EVERBEE
  if (EVERBEE_COOKIES) {
    headers['cookie'] = EVERBEE_COOKIES;
  }

  evContext = await browser.newContext({
    baseURL: EV_BASE,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    locale: 'en-US',
    extraHTTPHeaders: headers
  });
}

async function recycleBrowser(reason){
  console.warn('[browser] Reciclando navegador:', reason);
  try { if (evContext) await evContext.close(); } catch {}
  try { if (browser) await browser.close(); }    catch {}
  browser   = null;
  evContext = null;
  consecutiveErrors = 0;
}

/* Abrir una URL interna de EverBee ya autenticado */
async function openEv(page, pathAndQuery){
  await jitter();
  const url = pathAndQuery.startsWith('http') ? pathAndQuery : `${EV_BASE}${pathAndQuery}`;
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle',{ timeout: 60000 }).catch(()=>{});
  await jitter();
  return resp;
}

/* ============================
   SCRAPERS ESPECÍFICOS EVERBEE
============================ */

/** Keyword Research: /keyword-research?keyword=... (pestaña Keyword Ideas) */
async function scrapeEverbeeKeywords(q, limit){
  await ensureBrowser();
  const page = await evContext.newPage();

  // Abrimos la página de keyword research con el keyword
  await openEv(page, `/keyword-research?keyword=${encodeURIComponent(q)}`);

  // Aseguramos estar en la pestaña correcta si existe
  await page.waitForTimeout(2000);
  try {
    const tab = page.getByRole('tab', { name: /keyword/i });
    if (await tab.isVisible()) {
      await tab.click().catch(()=>{});
      await page.waitForLoadState('networkidle',{timeout:10000}).catch(()=>{});
    }
  } catch {}

  // Esperar filas
  await page.waitForSelector('table tbody tr', { timeout: 10000 }).catch(()=>{});

  const rows = await page.$$eval('table tbody tr', trs => {
    const out = [];
    for (const tr of trs) {
      const tds = Array.from(tr.querySelectorAll('td')).map(td=>td.textContent.trim());
      if (!tds.length) continue;
      out.push({
        keyword:      tds[0] || '',
        volume:       tds[1] || '',
        competition:  tds[2] || ''
      });
    }
    return out;
  });

  await page.close();

  let items = (rows || []).filter(r=>r.keyword);
  const seen=new Set();
  items = items.filter(r=>{
    const k = r.keyword.toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    r.score = (r.score !== undefined ? r.score :  score(r.volume, r.competition));
    return true;
  });

  items.sort((a,b)=> (b.score||0) - (a.score||0));

  return items.slice(0, limit);
}

/** Product Analytics: /product-analytics?search_term=... */
async function scrapeEverbeeProducts(q, limit){
  await ensureBrowser();
  const page = await evContext.newPage();

  await openEv(page, `/product-analytics?search_term=${encodeURIComponent(q)}`);
  await page.waitForSelector('table tbody tr', { timeout: 10000 }).catch(()=>{});

  const rows = await page.$$eval('table tbody tr', trs => {
    const out=[];
    for (const tr of trs) {
      const tds = Array.from(tr.querySelectorAll('td')).map(td=>td.textContent.trim());
      if (!tds.length) continue;
      // Ajusta índices si en EverBee cambian columnas
      out.push({
        title:  tds[0] || '',
        shop:   tds[1] || '',
        price:  tds[2] || '',
        views:  tds[3] || '',
        sales:  tds[4] || '',
        favs:   tds[5] || ''
      });
    }
    return out;
  });

  await page.close();

  const items = (rows || []).filter(r=>r.title).map(r=>{
    const views = toInt(r.views);
    const favs  = toInt(r.favs);
    const sales = toInt(r.sales);
    const sc    = views*0.6 + favs*1.2 + sales*5;
    return { ...r, views, favorites:favs, sales, score:sc };
  });

  items.sort((a,b)=> (b.score||0) - (a.score||0));
  return items.slice(0, limit);
}

/** Shop Analyzer: /shop-analyzer */
async function scrapeEverbeeShops(limit){
  await ensureBrowser();
  const page = await evContext.newPage();

  await openEv(page, `/shop-analyzer`);
  await page.waitForSelector('table tbody tr', { timeout: 10000 }).catch(()=>{});

  const rows = await page.$$eval('table tbody tr', trs => {
    const out=[];
    for (const tr of trs) {
      const tds = Array.from(tr.querySelectorAll('td')).map(td=>td.textContent.trim());
      if (!tds.length) continue;
      out.push({
        shop:    tds[0] || '',
        sales:   tds[1] || '',
        revenue: tds[2] || '',
        views:   tds[3] || '',
        favs:    tds[4] || ''
      });
    }
    return out;
  });

  await page.close();

  const items = (rows || []).filter(r=>r.shop).map(r=>{
    const sales = toInt(r.sales);
    const rev   = toInt(r.revenue);
    const views = toInt(r.views);
    const favs  = toInt(r.favs);
    const sc    = sales*5 + rev*0.001 + views*0.1 + favs*0.5;
    return { ...r, sales, revenue:rev, views, favorites:favs, score:sc };
  });

  items.sort((a,b)=> (b.score||0) - (a.score||0));
  return items.slice(0, limit);
}

/** My Shop: /?tab=overview */
async function scrapeEverbeeMyShop(){
  await ensureBrowser();
  const page = await evContext.newPage();

  await openEv(page, `/`); // página principal de tu shop
  await page.waitForTimeout(3000);

  const html = await page.content();
  await page.close();

  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g,' ');

  function findNumAround(label){
    const re = new RegExp(label + '\\s*:?\\s*([\\d.,]+)', 'i');
    const m = text.match(re);
    if (m) return m[1];
    return '';
  }

  const stats = {
    sales:   findNumAround('Sales'),
    revenue: findNumAround('Revenue'),
    listings: findNumAround('Active Listings')
  };

  return stats;
}

/* ============================
   HEALTH & DEBUG
============================ */

app.get('/healthz', (_req,res)=> {
  res.json({ ok:true, service:'everbee-scraper', stealth:STEALTH_ON });
});

app.get('/debug/browser-check', async (_req,res)=>{
  try{
    const b = await chromium.launch({ headless:true, args:['--no-sandbox','--disable-dev-shm-usage'] });
    const page = await b.newPage();
    await page.goto('https://example.com', { waitUntil:'domcontentloaded' });
    const ua = await page.evaluate(()=>navigator.userAgent);
    await b.close();
    res.json({ ok:true, userAgent:ua });
  }catch(e){
    res.status(500).json({ error:e.message });
  }
});

/* ============================
   ENDPOINTS HTTP PÚBLICOS
============================ */

/** GET /everbee/keyword-research?q=...&limit=10 */
app.get('/everbee/keyword-research', async (req,res)=>{
  const q     = (req.query.q || '').toString().trim();
  const limit = parseInt(req.query.limit || '10', 10);
  if (!q) return res.status(400).json({ error:'Falta parámetro q' });

  try{
    const items = await scrapeEverbeeKeywords(q, limit);
    res.json({ query:q, count:items.length, results:items });
  }catch(e){
    res.status(500).json({ error:e.message || String(e) });
  }
});

/** GET /everbee/product-analytics?q=...&limit=10 */
app.get('/everbee/product-analytics', async (req,res)=>{
  const q     = (req.query.q || '').toString().trim();
  const limit = parseInt(req.query.limit || '10', 10);
  if (!q) return res.status(400).json({ error:'Falta parámetro q' });

  try{
    const items = await scrapeEverbeeProducts(q, limit);
    res.json({ query:q, count:items.length, results:items });
  }catch(e){
    res.status(500).json({ error:e.message || String(e) });
  }
});

/** GET /everbee/shop-analyzer?limit=10 */
app.get('/everbee/shop-analyzer', async (req,res)=>{
  const limit = parseInt(req.query.limit || '10', 10);
  try{
    const items = await scrapeEverbeeShops(limit);
    res.json({ count:items.length, results:items });
  }catch(e){
    res.status(500).json({ error:e.message || String(e) });
  }
});

/** GET /everbee/my-shop */
app.get('/everbee/my-shop', async (_req,res)=>{
  try{
    const stats = await scrapeEverbeeMyShop();
    res.json({ stats });
  }catch(e){
    res.status(500).json({ error:e.message || String(e) });
  }
});

/* ============================
   START
=========================== */
app.listen(port, ()=> {
  console.log(`[everbee] API escuchando en puerto ${port}`);
});
