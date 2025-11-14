const { test, expect } = require('@playwright/test');

test('login to EverBee', async ({ page }) => {
  await page.goto('https://app.everbee.io');
  
  // Reemplaza los selectores por los correctos
  await page.fill('input[name="email"]', 'leticiaterranegra@hotmail.com');
  await page.fill('input[name="password"]', 'g4DwW6W.XKSsdgR');
  await page.click('button[type="submit"]');

  // Verifica que el login fue exitoso
  await expect(page).toHaveURL('https://app.everbee.io/dashboard');
});
// archivo creado
