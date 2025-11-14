// index.js — OrbiDigi EverBee Scraper (Playwright + DOM directo) — FINAL

const express = require('express');
const cheerio = require('cheerio');
const { chromium } = require('playwright');

const app  = express();
const port = process.env.PORT || 10000;

/* ====== ENV ====== */
const EVERBEE_COOKIES = (process.env.EVERBEE_COOKIES || '').trim(); // ej: "everbeeToken=eyJhbGciOi..."
const STEALTH_ON      = (process.env.STEALTH_ON || '1') !== '0';
const MAX_RETRIES     = parseInt(process.env.MAX_RETRIES || '3', 10);
const RECYCLE_AFTER   = parseInt(process.env.RECYCLE_AFTER || '6', 10);

const EV_BASE = 'https://app.everbee.io';

/* ====== RUNTIME ====== */
let browser = null;
let evContext = null;
let consecutiveErrors = 0;

/* ====== UTILS ====== */
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const rand   = (a,b)=> Math.floor(Math.random()*(b-a+1))+a;
const jitter = ()=> STEALTH_ON ? sleep(rand(250,700)) : Promise.resolve();

const toInt = v => {
  if (v == null) return 0;
  if (typeof v === 'number') return Math.floor(v);
  if (typeof v === 'string') {
    const m = v.replace(/[^\d]/g,'');
    return m ? parseInt(m, 10) : 0;
  }
  return 0;
};

const score = (volume, comp) => {
  const v = toInt(volume);
  const c = toInt(comp);
  return v / (c + 1);
};

async function recycleBrowser(reason = 'recycle') {
  console.warn('[browser] recycle:', reason);
  try { if (evContext) await evContext.close(); } catch {}
  try { if (browser)   await browser.close();   } catch {}
  browser = null;
  evContext = null;
  consecutiveErrors = 0;
}

async function ensureBrowser() {
  if (browser && evContext) return;

  console.log('[browser] launch new chromium');
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const headers = {
    'accept-language': 'en-US,en;q=0.9'
  };

  // 👉 Aquí metemos el everbeeToken como cabecera Cookie
  if (EVERBEE_COOKIES) {
    headers['cookie'] = EVERBEE_COOKIES;
  }

  evContext = await browser.newContext({
    baseURL: EV_BASE,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    extraHTTPHeaders: headers
  });
}

async function openAndIdle(page, pathAndQuery) {
  await jitter();
  const url = pathAndQuery.startsWith('http')
    ? pathAndQuery
    : `${EV_BASE}${pathAndQuery}`;
  const resp = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  await jitter();
  return resp;
}

async function withRetries(fn, label = 'task') {
  let last;
  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      const out = await fn();
      consecutiveErrors = 0;
      return out;
    } catch (e) {
      last = e;
      console.warn(`[${label}] intento ${i}/${MAX_RETRIES} fallo:`, e.message || e);
      await sleep(rand(700, 1500));
      if (++consecutiveErrors >= RECYCLE_AFTER) {
        await recycleBrowser(`too many errors in ${label}`);
        await ensureBrowser();
      }
    }
  }
  throw last;
}

/* ===== HEALTH / DEBUG ===== */
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'everbee-scraper', stealth: STEALTH_ON });
});

app.get('/diag/browser-check', async (_req, res) => {
  try {
    const b = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
    const page = await b.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
    const ua = await page.evaluate(() => navigator.userAgent);
    await b.close();
    res.json({ ok: true, userAgent: ua });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ===== HELPERS DOM ===== */

async function openEv(pathAndQuery) {
  await ensureBrowser();
  const page = await evContext.newPage();
  await openAndIdle(page, pathAndQuery);
  return page;
}

/* ===== 1) KEYWORD RESEARCH ===== */
/**
 * URL en UI: app.everbee.io/keyword-research?keyword=planner
 * Columnas: Keyword | Volume | Competition | Keyword Score
 */
app.get('/everbee/keyword-research', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit || '30', 10)));
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });

  try {
    const results = await withRetries(async () => {
      const page = await openEv(`/keyword-research?keyword=${encodeURIComponent(q)}`);

      // espera tabla
      await page.waitForSelector('table tbody tr', { timeout: 15000 }).catch(() => {});
      const rows = await page.$$eval('table tbody tr', trs =>
        trs
          .map(tr => {
            const tds = Array.from(tr.querySelectorAll('td')).map(td =>
              td.textContent.trim()
            );
            if (!tds.length) return null;
            return {
              keyword: tds[0] || '',
              volume: tds[1] || '',
              competition: tds[2] || ''
            };
          })
          .filter(Boolean)
      );
      await page.close();

      let arr = rows.filter(r => r.keyword);
      const seen = new Set();
      arr = arr.filter(r => {
        const k = r.keyword.toLowerCase();
        if (!k || seen.has(k)) return false;
        seen.add(k);
        r.score = score(r.volume, r.competition);
        return true;
      });

      arr.sort(
        (a, b) =>
          (b.score || 0) - (a.score || 0) ||
          toInt(b.volume) - toInt(a.volume)
      );

      return arr.slice(0, limit);
    }, 'everbee/keyword-research');

    res.json({ query: q, count: results.length, results });
  } catch (e) {
    console.error('keyword-research error:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* ===== 2) PRODUCT ANALYTICS ===== */
/**
 * URL en UI: app.everbee.io/product-analytics?search_term=coloring+book
 * Columnas: Product | Shop Name | Price | Sales | Revenue
 */
app.get('/everbee/product-analytics', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit || '20', 10)));
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });

  try {
    const results = await withRetries(async () => {
      const page = await openEv(
        `/product-analytics?search_term=${encodeURIComponent(q)}`
      );
      await page.waitForSelector('table tbody tr', { timeout: 15000 }).catch(() => {});

      const rows = await page.$$eval('table tbody tr', trs =>
        trs
          .map(tr => {
            const tds = Array.from(tr.querySelectorAll('td')).map(td =>
              td.textContent.trim()
            );
            if (!tds.length) return null;
            return {
              product: tds[0] || '',
              shop:    tds[1] || '',
              price:   tds[2] || '',
              sales:   tds[4] || '',
              revenue: tds[5] || ''
            };
          })
          .filter(Boolean)
      );
      await page.close();

      const arr = rows
        .filter(r => r.product)
        .slice(0, limit)
        .map(r => {
          const views = 0;
          const favs  = 0;
          const sales = toInt(r.sales);
          const rev   = toInt(r.revenue);
          const sc    = sales * 5 + rev * 0.001;
          return { ...r, views, favorites: favs, score: sc };
        });

      return arr;
    }, 'everbee/product-analytics');

    res.json({ query: q, count: results.length, results });
  } catch (e) {
    console.error('product-analytics error:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* ===== 3) SHOP ANALYZER ===== */
/**
 * URL en UI: app.everbee.io/shop-analyzer
 * Columnas (según captura):
 * Shop Name | Total Sales | Total Revenue | Mo. Sales | Mo. Revenue | Shop Age | Reviews | Total Favorites | Currency | Location | Active Listings | Digital Listings
 */
app.get('/everbee/shop-analyzer', async (req, res) => {
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit || '20', 10)));

  try {
    const results = await withRetries(async () => {
      const page = await openEv('/shop-analyzer');
      await page.waitForSelector('table tbody tr', { timeout: 15000 }).catch(() => {});

      const rows = await page.$$eval('table tbody tr', trs =>
        trs
          .map(tr => {
            const tds = Array.from(tr.querySelectorAll('td')).map(td =>
              td.textContent.trim()
            );
            if (!tds.length) return null;
            return {
              shopName: tds[0] || '',
              totalSales: tds[1] || '',
              totalRevenue: tds[2] || '',
              moSales:  tds[3] || '',
              moRevenue: tds[4] || '',
              shopAge: tds[5] || '',
              reviews: tds[6] || '',
              totalFavorites: tds[7] || '',
              currency: tds[8] || '',
              location: tds[9] || '',
              activeListings: tds[10] || '',
              digitalListings: tds[11] || ''
            };
          })
          .filter(Boolean)
      );
      await page.close();

      return rows.slice(0, limit);
    }, 'everbee/shop-analyzer');

    res.json({ count: results.length, results });
  } catch (e) {
    console.error('shop-analyzer error:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* ===== 4) MY SHOP (Overview) ===== */
/**
 * URL en UI: app.everbee.io/?tabName=Overview
 * Cards: Sales, Revenue, Listings, etc.
 */
app.get('/everbee/my-shop', async (_req, res) => {
  try {
    const stats = await withRetries(async () => {
      const page = await openEv('/?tabName=Overview');
      await page.waitForTimeout(3000);
      const html = await page.content();
      await page.close();

      const $ = cheerio.load(html);
      const txt = $('body').text().replace(/\s+/g, ' ');

      const grab = (regex) => {
        const m = txt.match(regex);
        return m ? (m[1] || m[2] || '').trim() : '';
      };

      const out = {
        sales:    grab(/(Total Sales|Sales)\s*:?[\s]*([\d,.]+)/i),
        revenue:  grab(/(Total Revenue|Revenue)\s*:?[\s]*(\$?[\d,.]+)/i),
        listings: grab(/(Active Listings|Listings)\s*:?[\s]*([\d,.]+)/i)
      };

      return out;
    }, 'everbee/my-shop');

    res.json({ stats });
  } catch (e) {
    console.error('my-shop error:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* ===== START ===== */
app.listen(port, () => {
  console.log(`[everbee] scraper escuchando en puerto ${port}`);
});
