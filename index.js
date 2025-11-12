// index.js — EverBee scraper (Playwright headless, sin ZenRows)
// Express + Playwright + captura XHR + fallback DOM (tablas) + dedupe + ranking

const express = require('express');
const cheerio = require('cheerio');
const { chromium } = require('playwright');

const app = express();
const port = process.env.PORT || 3000;

/* ====== ENV ====== */
const EVERBEE_COOKIES  = (process.env.EVERBEE_COOKIES || '').trim();
const STEALTH_ON       = (process.env.STEALTH_ON || '1') !== '0';
const MAX_RETRIES      = parseInt(process.env.MAX_RETRIES || '3', 10);
const RECYCLE_AFTER    = parseInt(process.env.RECYCLE_AFTER || '6', 10);

/* ====== BASE URLS ====== */
const ETSY     = 'https://www.etsy.com';
const EVERBEE  = 'https://app.everbee.io';

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
    const i=p.indexOf('='); if (i<=0) return null;
    return { name:p.slice(0,i).trim(), value:p.slice(i+1).trim(), path:'/', secure:true, httpOnly:false, sameSite:'None' };
  }).filter(Boolean);
}

/* ====== BROWSER ====== */
async function recycle(reason='stale'){
  try{ if(context) await context.close().catch(()=>{}); }catch{}
  try{ if(browser) await browser.close().catch(()=>{}); }catch{}
  browser=context=null; consecutiveErrors=0; console.warn('[recycle]', reason);
}
async function ensureBrowser(){
  if (browser && context) return;
  browser = await chromium.launch({ headless:true, args:['--no-sandbox','--disable-dev-shm-usage']});
  const ctxOpts = {
    baseURL: ETSY,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    locale: 'en-US',
    extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' }
  };
  context = await browser.newContext(ctxOpts);

  if (EVERBEE_COOKIES){
    const parsed = cookiesFromString(EVERBEE_COOKIES);
    const targets = [
      { domain: 'www.etsy.com' }, { domain: '.etsy.com' },
      { domain: 'app.everbee.io' }, { domain: '.everbee.io' }
    ];
    const all=[]; for(const c of parsed) for(const t of targets) all.push({...c, ...t});
    try{ await context.addCookies(all); }catch(e){ console.error('addCookies:', e.message); }
  }
}
async function openAndIdle(page, url){
  await jitter();
  const r=await page.goto(url, {waitUntil:'domcontentloaded', timeout:60000});
  await page.waitForLoadState('networkidle', {timeout:60000}).catch(()=>{});
  await jitter();
  return r;
}
async function withRetries(fn, label='task'){
  let last; for(let i=1;i<=MAX_RETRIES;i++){
    try{ const r=await fn(); consecutiveErrors=0; return r; }
    catch(e){ last=e; console.warn(`[${label}] retry ${i}/${MAX_RETRIES}`, e.message||e);
      await sleep(rand(600,1400)*i);
      if (++consecutiveErrors>=RECYCLE_AFTER){ await recycle(label); await ensureBrowser(); }
    }
  } throw last;
}

/* ====== XHR CAPTURE ====== */
function findArraysDeep(obj, pred, acc=[]){
  if (!obj || typeof obj!=='object') return acc;
  if (Array.isArray(obj) && obj.some(pred)) acc.push(obj);
  for (const k of Object.keys(obj)) findArraysDeep(obj[k], pred, acc);
  return acc;
}
async function captureJson(page, pred, ms=4000){
  const bag=[]; const h = async (r)=>{
    try{
      const ct=(r.headers()['content-type']||'').toLowerCase();
      if (!ct.includes('application/json')) return;
      const t=await r.text(); const j=JSON.parse(t);
      const arrs=findArraysDeep(j, pred);
      if (arrs.length) bag.push({ json:j, arrays:arrs });
    }catch{}
  };
  page.on('response',h); await page.waitForTimeout(ms); page.off('response',h);
  return bag;
}

/* ====== FALLBACK PARSERS ====== */
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
/* para products por si no hay XHR */
function parseListingsHTML(html){
  const $=cheerio.load(html), out=[];
  $('a[href*="/listing/"]').each((_,a)=>{
    const href=$(a).attr('href')||''; const title=$(a).attr('title')||$(a).text().trim();
    if (href || title) out.push({ listing_id:'', title, href, shop_name:'', views:0, favorites:0, sales:0, score:0 });
  });
  return out;
}

/* ====== HEALTH ====== */
app.get('/healthz', (_q,r)=> r.json({ ok:true, service:'everbee-playwright' }));

/* ====== 1) KEYWORD RESEARCH ====== */
app.get('/everbee/keyword-research', async (req,res)=>{
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit||'30',10)));
  try{
    const out = await withRetries(async ()=>{
      await ensureBrowser(); const p=await context.newPage();
      await openAndIdle(p, `${EVERBEE}/keyword-research`);

      // XHR: keyword/term + volume/searches + competition
      const cap = await captureJson(p, o =>
        o && typeof o==='object' &&
        ('keyword' in o || 'term' in o) &&
        ('volume' in o || 'searches' in o || 'avg_searches' in o),
        7000
      );

      let rows=[];
      for (const h of cap) for (const arr of h.arrays) for (const o of arr){
        const keyword=(o.keyword||o.term||'').toString().trim();
        const volume =(o.volume ||o.searches||o.avg_searches||'').toString().trim();
        const comp   =(o.competition||o.keyword_competition||o.etsy_competition||'').toString().trim();
        if (keyword) rows.push({ keyword, volume, competition:comp, score:score(volume,comp) });
      }

      // DOM fallback (tabla: Keywords | Volume | Competition | Keyword Score)
      if (!rows.length){
        const html=await p.content();
        const dom = parseTableRows(html, { keyword:0, volume:1, competition:2 });
        rows = dom.map(r=> ({ ...r, score:score(r.volume, r.competition) }));
      }

      await p.close();
      rows = rows.filter(r=>r.keyword);
      rows = dedupeBy(rows, r=>r.keyword.toLowerCase());
      rows.sort((a,b)=> (b.score - a.score) || (toInt(b.volume)-toInt(a.volume)));
      return { count: Math.min(rows.length, limit), results: rows.slice(0,limit) };
    }, 'everbee-keyword-research');
    res.json(out);
  }catch(e){ res.status(500).json({ error:e.message||String(e) }); }
});

/* ====== 2) PRODUCT ANALYTICS ====== */
app.get('/everbee/product-analytics', async (req,res)=>{
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit||'20',10)));
  try{
    const out = await withRetries(async ()=>{
      await ensureBrowser(); const p=await context.newPage();
      await openAndIdle(p, `${EVERBEE}/product-analytics`);

      // XHR: product/title + shop_name + revenue/sales/views/price
      const cap = await captureJson(p, o =>
        o && typeof o==='object' &&
        ('product' in o || 'title' in o) &&
        ('revenue' in o || 'sales' in o || 'views' in o || 'price' in o),
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
        const html=await p.content();
        // Mapeo columnas según tu captura (ajústalo si cambia):
        // Product(0) | Shop Name(1) | Price(2) | Sales(4) | Revenue(5) | ... | Total Views(??)
        const dom = parseTableRows(html, { product:0, shop:1, price:2, sales:4, revenue:5 });
        items = dom;
      }

      await p.close();
      items = items.slice(0, limit);
      return { count: items.length, results: items };
    }, 'everbee-product-analytics');
    res.json(out);
  }catch(e){ res.status(500).json({ error:e.message||String(e) }); }
});

/* ====== 3) SHOP ANALYZER ====== */
app.get('/everbee/shop-analyzer', async (req,res)=>{
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit||'20',10)));
  try{
    const out = await withRetries(async ()=>{
      await ensureBrowser(); const p=await context.newPage();
      await openAndIdle(p, `${EVERBEE}/shop-analyzer`);

      const cap = await captureJson(p, o =>
        o && typeof o==='object' &&
        ('shop_name' in o || 'shop' in o) &&
        ('total_sales' in o || 'total_revenue' in o || 'favorites' in o || 'reviews' in o),
        8000
      );

      let shops=[];
      for (const h of cap) for (const arr of h.arrays) for (const o of arr){
        const name =(o.shop_name||o.shop||'').toString().trim();
        const total_sales   = toInt(o.total_sales);
        const total_revenue = (o.total_revenue || '').toString().trim();
        const reviews       = toInt(o.reviews || o.total_reviews);
        const favorites     = toInt(o.favorites || o.total_favorites);
        const currency      = (o.currency || '').toString().trim();
        const location      = (o.location || '').toString().trim();
        const active_listings  = toInt(o.active_listings);
        const digital_listings = toInt(o.digital_listings);
        if (name) shops.push({ name, total_sales, total_revenue, reviews, favorites, currency, location, active_listings, digital_listings });
      }

      if (!shops.length){
        const html=await p.content();
        // Shop Name(0) | Total Sales(1) | Total Revenue(2) | ... | Currency(8) | Location(9) | Active(10) | Digital(11)
        const dom = parseTableRows(html, { name:0, total_sales:1, total_revenue:2, reviews:6, favorites:7, currency:8, location:9, active_listings:10, digital_listings:11 });
        shops = dom;
      }

      await p.close();
      shops = shops.slice(0, limit);
      return { count: shops.length, results: shops };
    }, 'everbee-shop-analyzer');
    res.json(out);
  }catch(e){ res.status(500).json({ error:e.message||String(e) }); }
});

/* ====== 4) MY SHOP (OVERVIEW) ====== */
app.get('/everbee/my-shop', async (_req,res)=>{
  try{
    const out = await withRetries(async ()=>{
      await ensureBrowser(); const p=await context.newPage();
      await openAndIdle(p, `${EVERBEE}/my-shop`);

      // XHR: sales / revenue / lifetime / avg_price ...
      const cap = await captureJson(p, o =>
        o && typeof o==='object' &&
        ('sales' in o || 'revenue' in o || 'lifetime' in o || 'avg_price' in o || 'listing_count' in o),
        5000
      );

      const stats={};
      for (const h of cap) for (const arr of h.arrays) for (const o of arr){
        const kps=['sales','revenue','lifetime','avg_price','total_revenue','listing_count','review_rate','average_price','sales_per_listing'];
        for (const k of kps){ if (o[k]!=null && stats[k]==null) stats[k]=o[k]; }
      }

      // fallback DOM
      if (!Object.keys(stats).length){
        const html=await p.content(); const $=cheerio.load(html);
        const text = s=>($(s).text()||'').trim().replace(/\s+/g,' ');
        // heurística sobre tarjetas
        const body=$('body').text().toLowerCase();
        const num = s=> (s||'').match(/\$?[\d,\.]+/)?.[0] || '';
        const find = (label)=> num((new RegExp(`${label}[\\s:\\$]*([\\d,\\.]+)`, 'i')).exec($('body').text())?.[1] || '');
        if (!stats.sales)   stats.sales   = find('sales');
        if (!stats.revenue) stats.revenue = find('revenue');
      }

      await p.close();
      return { stats };
    }, 'everbee-my-shop');
    res.json(out);
  }catch(e){ res.status(500).json({ error:e.message||String(e) }); }
});

/* ====== START ====== */
app.listen(port, ()=> console.log(`[everbee] listening on :${port}`));
