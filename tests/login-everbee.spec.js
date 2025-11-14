// login-everbee.spec.js
const { test, expect } = require('@playwright/test');

// ⚠️ Mejor: configura estas credenciales como variables de entorno
const EVERBEE_EMAIL = process.env.EVERBEE_EMAIL || 'leticiaterranegra@hotmail.com';
const EVERBEE_PASSWORD = process.env.EVERBEE_PASSWORD || 'g4DwW6W.XKSsdgR';

test('login to EverBee', async ({ page }) => {
  await page.goto('https://app.everbee.io', { waitUntil: 'networkidle' });

  await page.fill('input[name="email"]', EVERBEE_EMAIL);
  await page.fill('input[name="password"]', EVERBEE_PASSWORD);
  await page.click('button[type="submit"]');

  // 1) La app te deja en la raíz, no en /dashboard
  await expect(page).toHaveURL(/https:\/\/app\.everbee\.io\/?$/);

  // 2) Comprobación basada en UI (más estable)
  await expect(page.getByText('My Shop')).toBeVisible();
  await expect(page.getByText('OrbiDigi')).toBeVisible();
});
