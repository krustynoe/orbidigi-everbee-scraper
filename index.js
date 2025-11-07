const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const port = process.env.PORT || 3000;

app.get('/', async (req, res) => {
  const keyword = req.query.q || 'digital planner';
  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true
    });
    const page = await browser.newPage();

    // Try to use cookies from environment variable
    const cookiesString = process.env.EVERBEE_COOKIES || process.env.EVERBEE_COOKIE || '';
    if (cookiesString.trim()) {
      try {
        const cookies = [];
        const lines = cookiesString.split(/\r?\n/);
        for (const line of lines) {
          if (!line || line.startsWith('#')) continue;
          const parts = line.split('\t');
          if (parts.length >= 7) {
            cookies.push({
              name: parts[5],
              value: parts[6],
              domain: parts[0],
              path: parts[2],
              httpOnly: false,
              secure: parts[3].toUpperCase() === 'TRUE',
            });
          }
        }
        // Navigate to base domain before setting cookies
        await page.goto('https://app.everbee.io', { waitUntil: 'networkidle2' });
        await page.setCookie(...cookies);
        await page.reload({ waitUntil: 'networkidle2' });
      } catch (err) {
        console.error('Failed to apply cookies:', err);
      }
    } else {
      // Fallback login with email and password
      await page.goto('https://app.everbee.io/login', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#email', { timeout: 15000 });
      await page.type('#email', process.env.EVERBEE_EMAIL || '');
      await page.type('#password', process.env.EVERBEE_PASS || '');
      await Promise.all([
        page.click("button[type='submit']"),
        page.waitForNavigation({ waitUntil: 'networkidle2' })
      ]);
    }

    // Navigate to research page after authentication
    await page.goto('https://app.everbee.io/research', { waitUntil: 'networkidle2' });
    await page.waitForTimeout(5000);

    const result = await page.evaluate(() => {
      return [...document.querySelectorAll('h3')].map(el => el.innerText);
    });

    res.json({ keyword, result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.toString() });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.listen(port, () => {
  console.log('EVERBEE scraper live on port ' + port);
});
