const express = require('express');
const puppeteer = require('puppeteer');


const app = express();
const port = process.env.PORT || 3000;


app.get('/', async (req, res) => {
const keyword = req.query.q || 'digital planner';


const browser = await puppeteer.launch({
headless: true,
executablePath: '/usr/bin/google-chrome',
args: ['--no-sandbox', '--disable-setuid-sandbox']
});


const page = await browser.newPage();
await page.goto('https://app.everbee.io/login');


await page.type('#email', process.env.EVERBEE_EMAIL);
await page.type('#password', process.env.EVERBEE_PASS);
await page.click('button[type="submit"]');
await page.waitForNavigation();


await page.goto('https://app.everbee.io/research');
await page.waitForTimeout(5000);


const result = await page.evaluate(() => {
return [...document.querySelectorAll('h3')].map(el => el.innerText);
});


await browser.close();
res.json({ keyword, result });
});


app.listen(port, () => {
console.log(`EVERBEE scraper live on port ${port}`);
});