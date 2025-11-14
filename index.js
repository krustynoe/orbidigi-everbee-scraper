// index.js — OrbiDigi EverBee Scraper (Puppeteer + login automático)

const express   = require('express');
const cheerio   = require('cheerio');
const puppeteer = require('puppeteer');

const app  = express();
const port = process.env.PORT || 10000;

/* ========= ENV ========= */

const EVERBEE_EMAIL    = process.env.EVERBEE_EMAIL || '';
const EVERBEE_PASSWORD = process.env.EVERBEE_PASSWORD || '';

if (!EVERBEE_EMAIL || !EVERBEE_PASSWORD) {
  console.warn('[everbee] ⚠️ Falta EVERBEE_EMAIL o EVERBEE_PASSWORD en el entorno');
}

/* ========= PUPPETEER SINGLETON ========= */

let browser = null;
let page    = null;
let lastLoginTs = 0;
const LOGIN_TTL_MS = 15 * 60 * 1000; // 15 min

async function getBrowser() {
  if (browser && !browser.isClosed?.()) return browser;

  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  return browser;
}

async function getPage() {
  const br = await getBrowser();
  if (page && !page.isClosed()) return page;

  page = await br.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  return page;
}

/* ========= LOGIN ========= */

async function ensureLoggedIn() {
  const p = await getPage();

  // Si el login es reciente, reaprovechamos sesión
  if (Date.now() - lastLoginTs < LOGIN_TTL_MS) return p;

  console.log('[everbee] realizando login…');

  await p.goto('https://app.everbee.io', { waitUntil: 'networkidle2' });

  // Si ya estamos dentro, no hace falta loguear
  const url = p.url();
  if (!/login|auth/i.test(url)) {
    console.log('[everbee] ya logueado, url:', url);
    lastLoginTs = Date.now();
    return p;
  }

  // Espera inputs
  await p.waitForSelector('input[name="email"]', { timeout: 15000 });

  // Quita readonly de email y password
  await p.evaluate(() => {
    const emailInput    = document.querySelector('input[name="email"]');
    const passwordInput = document.querySelector('input[name="password"]');
    if (emailInput)    emailInput.removeAttribute('readonly');
    if (passwordInput) passwordInput.removeAttribute('readonly');
  });

  // Rellena credenciales
  await p.click('input[name="email"]', { clickCount: 3 });
  await p.type('input[name="email"]', EVERBEE_EMAIL, { delay: 30 });

  await p.click('input[name="password"]', { clickCount: 3 });
  await p.type('input[name="password"]', EVERBEE_PASSWORD, { delay: 30 });

  // Enviar formulario con Enter (el botón puede estar disabled)
  await p.keyboard.press('Enter');

  // Espera redirección y carga del dashboard
  await p.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(3000);

  lastLoginTs = Date.now();
  console.log('[everbee] login OK, url actual:', p.url());

  return p;
}

/* ========= HELPERS DE SCRAPING ========= */

// Devuelve HTML actual de la página (por si quieres procesarlo desde Make/GPT)
async function snapshotHTML(p) {
  const html = await p.content();
  return html;
}

/* ========= ENDPOINTS ========= */

app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'everbee-scraper' });
});

/**
 * GET /everbee/my-shop
 * Devuelve un resumen básico de la vista "My Shop" + HTML crudo.
 */
app.get('/everbee/my-shop', async (req, res) => {
  try {
    const p = await ensureLoggedIn();

    await p.goto('https://app.everbee.io/', { waitUntil: 'networkidle2' });
    await p.waitForTimeout(2000);

    const html = await snapshotHTML(p);
    const $ = cheerio.load(html);

    // Intento simple de sacar nombre de tienda y algunas métricas
    let shopName = '';
    let sales    = '';
    let rating   = '';

    // Esto es aproximado; puedes refinarlo luego según la estructura real
    $('[class*="shop"], [class*="Shop"]').each((_, el) => {
      const text = $(el).text().trim();
      if (!shopName && text && text.length < 50) {
        shopName = text;
      }
    });

    // Estas cadenas son orientativas, las viste en el snapshot de Playwright
    const statsBlock = $('body').text();
    const salesMatch  = statsBlock.match(/(\d+)\s+Sales/i);
    const ratingMatch = statsBlock.match(/(\d+(\.\d+)?)\s*\(\d+\)/);

    if (salesMatch)  sales  = salesMatch[1];
    if (ratingMatch) rating = ratingMatch[1];

    res.json({
      ok: true,
      shop: {
        name: shopName || null,
        sales: sales || null,
        rating: rating || null
      },
      html
    });
  } catch (err) {
    console.error('[everbee] /everbee/my-shop error', err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

/**
 * GET /everbee/products
 * Carga la vista de Product Analytics y devuelve HTML.
 */
app.get('/everbee/products', async (req, res) => {
  try {
    const p = await ensureLoggedIn();

    // según tu UI, esta ruta suele ser /product-analytics
    await p.goto('https://app.everbee.io/product-analytics', { waitUntil: 'networkidle2' })
      .catch(async () => {
        // fallback: ir a root y hacer click textual
        await p.goto('https://app.everbee.io/', { waitUntil: 'networkidle2' });
      });

    await p.waitForTimeout(3000);

    const html = await snapshotHTML(p);
    res.json({ ok: true, html });
  } catch (err) {
    console.error('[everbee] /everbee/products error', err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

/**
 * GET /everbee/keyword-research?q=planner
 * Abre Keyword Research, lanza una búsqueda (si q) y devuelve HTML.
 */
app.get('/everbee/keyword-research', async (req, res) => {
  const q = (req.query.q || '').toString();

  try {
    const p = await ensureLoggedIn();

    await p.goto('https://app.everbee.io/keyword-research', { waitUntil: 'networkidle2' })
      .catch(async () => {
        // fallback: root + click
        await p.goto('https://app.everbee.io/', { waitUntil: 'networkidle2' });
      });

    await p.waitForTimeout(2000);

    if (q) {
      // busca un input de búsqueda razonable
      const searchSelectorCandidates = [
        'input[placeholder*="Search"]',
        'input[type="search"]',
        'input[name*="search"]'
      ];

      let selectorFound = null;
      for (const sel of searchSelectorCandidates) {
        const el = await p.$(sel);
        if (el) {
          selectorFound = sel;
          break;
        }
      }

      if (selectorFound) {
        await p.click(selectorFound, { clickCount: 3 });
        await p.type(selectorFound, q, { delay: 30 });
        await p.keyboard.press('Enter');
        await p.waitForTimeout(4000);
      }
    }

    const html = await snapshotHTML(p);
    res.json({ ok: true, query: q || null, html });
  } catch (err) {
    console.error('[everbee] /everbee/keyword-research error', err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

/* ========= START ========= */

app.listen(port, () => {
  console.log(`[everbee] listening on port ${port}`);
});
