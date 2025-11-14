// index.js — OrbiDigi EverBee Scraper (Express + Puppeteer)

const express   = require('express');
const cheerio   = require('cheerio');
const puppeteer = require('puppeteer');

const app  = express();
const port = process.env.PORT || 10000;

/* ========= ENV ========= */

const EVERBEE_EMAIL    = process.env.EVERBEE_EMAIL || '';
const EVERBEE_PASSWORD = process.env.EVERBEE_PASSWORD || '';

if (!EVERBEE_EMAIL || !EVERBEE_PASSWORD) {
  console.warn('[everbee] ⚠️ Falta EVERBEE_EMAIL o EVERBEE_PASSWORD en las variables de entorno');
}

/* ========= PUPPETEER SINGLETON ========= */

let browser = null;
let page    = null;
let lastLoginTs = 0;
const LOGIN_TTL_MS = 15 * 60 * 1000; // 15 minutos

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;

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

  // Timeouts amplios para entorno Render
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(60000);

  return page;
}

/* ========= LOGIN ========= */

async function ensureLoggedIn() {
  const p = await getPage();

  // Reusar sesión si el login es reciente
  if (Date.now() - lastLoginTs < LOGIN_TTL_MS) {
    return p;
  }

  console.log('[everbee] realizando login…');

  // Navegación inicial a EverBee
  await p.goto('https://app.everbee.io', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  const currentUrl = p.url();
  console.log('[everbee] URL tras primer goto:', currentUrl);

  // Si ya estamos dentro (sesión válida), no hacemos login
  if (!/login|auth|signin/i.test(currentUrl)) {
    console.log('[everbee] sesión ya activa, sin login adicional');
    lastLoginTs = Date.now();
    return p;
  }

  // Esperar a que aparezca el input de email
  await p.waitForSelector('input[name="email"]', { timeout: 30000 });

  // Quitar readonly de email y password
  await p.evaluate(() => {
    const emailInput    = document.querySelector('input[name="email"]');
    const passwordInput = document.querySelector('input[name="password"]');
    if (emailInput)    emailInput.removeAttribute('readonly');
    if (passwordInput) passwordInput.removeAttribute('readonly');
  });

  // Rellenar email
  await p.click('input[name="email"]', { clickCount: 3 });
  await p.type('input[name="email"]', EVERBEE_EMAIL, { delay: 30 });

  // Rellenar password
  await p.click('input[name="password"]', { clickCount: 3 });
  await p.type('input[name="password"]', EVERBEE_PASSWORD, { delay: 30 });

  // Enviar formulario con Enter (el botón puede estar disabled)
  await p.keyboard.press('Enter');

  // Esperar unos segundos a que cargue el dashboard
  await p.waitForTimeout(7000);

  console.log('[everbee] login completado, URL actual:', p.url());

  lastLoginTs = Date.now();
  return p;
}

/* ========= HELPERS DE SCRAPING ========= */

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
 * Devuelve resumen básico de "My Shop" + HTML completo.
 */
app.get('/everbee/my-shop', async (req, res) => {
  try {
    const p = await ensureLoggedIn();

    await p.goto('https://app.everbee.io/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await p.waitForTimeout(3000);

    const html = await snapshotHTML(p);
    const $ = cheerio.load(html);

    let shopName = '';
    let sales    = '';
    let rating   = '';

    // Intento simple de extraer nombre de tienda
    $('[class*="shop"], [class*="Shop"]').each((_, el) => {
      const text = $(el).text().trim();
      if (!shopName && text && text.length < 50) {
        shopName = text;
      }
    });

    const allText = $('body').text();
    const salesMatch  = allText.match(/(\d+)\s+Sales/i);
    const ratingMatch = allText.match(/(\d+(\.\d+)?)\s*\(\d+\)/);

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
    res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});

/**
 * GET /everbee/products
 * Carga Product Analytics y devuelve HTML.
 */
app.get('/everbee/products', async (req, res) => {
  try {
    const p = await ensureLoggedIn();

    // Intento directo a ruta de Product Analytics
    try {
      await p.goto('https://app.everbee.io/product-analytics', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
    } catch (e) {
      console.warn('[everbee] /product-analytics directo falló, usando fallback root', e.message);
      await p.goto('https://app.everbee.io/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
    }

    await p.waitForTimeout(3000);

    const html = await snapshotHTML(p);
    res.json({ ok: true, html });
  } catch (err) {
    console.error('[everbee] /everbee/products error', err);
    res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});

/**
 * GET /everbee/keyword-research?q=planner
 * Abre Keyword Research, lanza búsqueda (si q) y devuelve HTML.
 */
app.get('/everbee/keyword-research', async (req, res) => {
  const q = (req.query.q || '').toString();

  try {
    const p = await ensureLoggedIn();

    try {
      await p.goto('https://app.everbee.io/keyword-research', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
    } catch (e) {
      console.warn('[everbee] /keyword-research directo falló, usando root', e.message);
      await p.goto('https://app.everbee.io/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
    }

    await p.waitForTimeout(2000);

    if (q) {
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
      } else {
        console.warn('[everbee] no se encontró input de búsqueda en Keyword Research');
      }
    }

    const html = await snapshotHTML(p);
    res.json({ ok: true, query: q || null, html });
  } catch (err) {
    console.error('[everbee] /everbee/keyword-research error', err);
    res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});

/* ========= START ========= */

app.listen(port, () => {
  console.log(`[everbee] listening on port ${port}`);
});
