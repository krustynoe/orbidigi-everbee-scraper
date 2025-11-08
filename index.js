const express = require('express');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

app.get('/', async (req, res) => {
  const query = req.query.q || '';
  const apikey = process.env.ZENROWS_API_KEY;
  const cookiesString = process.env.EVERBEE_COOKIES || process.env.EVERBEE_COOKIE_KTE || '';

  if (!apikey) {
    return res.status(500).json({ error: 'Missing ZENROWS_API_KEY' });
  }

  try {
    const params = {
      apikey: apikey,
      url: 'https://app.everbee.io/research',
      js_render: 'true',
      custom_headers: 'true',
      css_extractor: JSON.stringify({ results: 'h2, h3' }),
    };

    const headers = {};

    // Build cookie header from Netscape cookie file string if provided
    if (cookiesString.trim()) {
      try {
        const lines = cookiesString.split(/\r?\n/);
        const cookiePairs = [];
        for (const line of lines) {
          if (!line || line.startsWith('#')) continue;
          const parts = line.split('\t');
          if (parts.length >= 7) {
            const name = parts[5];
            const value = parts[6];
            cookiePairs.push(`${name}=${value}`);
          }
        }
        if (cookiePairs.length > 0) {
          headers['Cookie'] = cookiePairs.join('; ');
        }
      } catch (err) {
        console.error('Error parsing cookies:', err);
      }
    }

    const response = await axios.get('https://api.zenrows.com/v1/', { params, headers });

    let results = response.data.results || [];
    if (query) {
      results = results.filter(item => item.toLowerCase().includes(query.toLowerCase()));
    }

    return res.json({ query, results });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Error fetching data' });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
