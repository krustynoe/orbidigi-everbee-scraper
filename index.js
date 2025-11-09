const express = require('express');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

const ZR = process.env.ZENROWS_API_KEY || '';
const EB = (process.env.EVERBEE_COOKIES || process.env.EVERBEE_COOKIE_KTE || '').trim();

function headersWithCookie(cookie) {
  return cookie ? { Cookie: cookie, 'User-Agent': 'Mozilla/5.0' } : { 'User-Agent': 'Mozilla/5.0' };
}

async function zenrows(url, extractor, cookie) {
  const params = {
    apikey: ZR,
    url,
    js_render: 'true',
    custom_headers: 'true',
    css_extractor: JSON.stringify(extractor),
  };
  const { data } = await axios.get('https://api.zenrows.com/v1/', { params, headers: headersWithCookie(cookie) });
  return data;
}

// keywords
app.get('/everbee/keywords', async (req, res) => {
  try {
    const q = req.query.q || '';
    const data = await zenrows(
      `https://app.everbee.io/research?search=${encodeURIComponent(q)}`,
      { results: { selector: 'h1,h2,h3,[data-testid="keyword"]', type: 'text', all: true } },
      EB
    );
    const results = Array.isArray(data.results) ? data.results.filter(Boolean) : [];
    res.json({ query: q, count: results.length, results: results.slice(0, 20) });
  } catch (e) { res.status(500).json({ error: e.response?.data || String(e) }); }
});

// products
app.get('/everbee/products', async (req, res) => {
  try {
    const q = req.query.q || '';
    const data = await zenrows(
      `https://www.etsy.com/search?q=${encodeURIComponent(q)}`,
      {
        items: [{
          selector: 'li[data-search-result]',
          values: {
            title: { selector: 'h3', type: 'text' },
            url:   { selector: 'a',  type: 'attr', attr: 'href' },
            price: { selector: '.currency-value', type: 'text', optional: true },
            shop:  { selector: '.v2-listing-card__shop', type: 'text', optional: true }
          }
        }]
      },
      EB
    );
    const items = Array.isArray(data.items) ? data.items : [];
    res.json({ query: q, count: items.length, items: items.slice(0, 20) });
  } catch (e) { res.status(500).json({ error: e.response?.data || String(e) }); }
});

// shops
app.get('/everbee/shops', async (req, res) => {
  try {
    const q = req.query.q || '';
    const data = await zenrows(
      `https://www.etsy.com/search?q=${encodeURIComponent(q)}`,
      {
        shops: { selector: '.v2-listing-card__shop', type: 'text', all: true },
        links: { selector: '.v2-listing-card__shop a', type: 'attr', attr: 'href', all: true }
      },
      EB
    );
    const shops = (data.shops || []).map((s, i) => ({ shop: s, url: data.links?.[i] || '' })).filter(x => x.shop);
    res.json({ query: q, count: shops.length, shops: shops.slice(0, 20) });
  } catch (e) { res.status(500).json({ error: e.response?.data || String(e) }); }
});

// myshop
app.get('/everbee/myshop', async (req, res) => {
  try {
    const shop = String(req.query.shop || '');
    if (!shop) return res.status(400).json({ error: "Missing 'shop' param" });
    const data = await zenrows(
      `https://www.etsy.com/shop/${encodeURIComponent(shop)}`,
      {
        items: [{
          selector: '.wt-grid__item-xs-6', // grid de listings (ajusta si difiere)
          values: {
            title: { selector: 'h3', type: 'text' },
            url:   { selector: 'a',  type: 'attr', attr: 'href' },
            price: { selector: '.currency-value', type: 'text', optional: true },
            tags:  { selector: '[data-buy-box-listing-tags]', type: 'text', optional: true }
          }
        }]
      },
      EB
    );
    const items = Array.isArray(data.items) ? data.items : [];
    res.json({ shop, count: items.length, items: items.slice(0, 50) });
  } catch (e) { res.status(500).json({ error: e.response?.data || String(e) }); }
});

app.listen(port, () => console.log('Everbee scraper listening on', port));
