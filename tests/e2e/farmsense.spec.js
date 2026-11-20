import { test, expect } from '@playwright/test';

test('Arduino HTTP telemetry → dashboard command → device acknowledgment → stop and offline state', async ({ page, request }) => {
  const deviceHeaders = { Authorization: 'Bearer e2e-device-key-only-for-tests' };
  const dashboardHeaders = { Authorization: 'Bearer e2e-dashboard-key-only-for-tests' };
  const boot = `browser-${Date.now()}`;
  let sequence = 0;
  let state = { control_mode: 'auto', control_reason: 'moisture_satisfied', irrigation_active: false };
  async function publish(changes = {}) {
    state = { ...state, ...changes };
    const result = await request.post('http://127.0.0.1:8001/telemetry', { headers: deviceHeaders, data: {
      device_id: 'farmsense-01', boot_id: boot, sequence: ++sequence, uptime_ms: sequence * 2000,
      moisture: 54, air_temperature: 26.5, humidity: 63, pressure: 1008.2, rain_detected: false, ...state,
    } });
    expect(result.ok()).toBeTruthy();
    return (await result.json()).command;
  }
  await publish();
  await request.post('http://127.0.0.1:8001/irrigation-active', { headers: dashboardHeaders, data: { mode: 'auto' } });
  const initial = await publish();
  await publish({ applied_command_id: initial.command_id });
  const heartbeat = setInterval(() => { publish().catch(() => {}); }, 1000);
  try {
  // Keep unrelated weather/AI services outside this hardware-flow test.
  for (const route of ['weather*', 'insights', 'chat/status']) {
    await page.route(`**/api/${route}`, (handler) => handler.fulfill({ json: { available: false, message: 'Not part of this test' } }));
  }
  await page.goto('/dashboard');
  const control = page.getByRole('region', { name: 'Remote irrigation', exact: true });
  await expect(control.getByText('Confirmed by Arduino')).toBeVisible();
  await expect(control.getByRole('button', { name: 'Water now' })).toBeDisabled();
  await control.getByLabel('Operator key').fill('e2e-operator-key-only-for-tests');
  await expect(control.getByRole('button', { name: 'Water now' })).toBeEnabled();
  const started = page.waitForResponse((response) => response.url().endsWith('/api/irrigation/remote') && response.request().method() === 'POST');
  await control.getByRole('button', { name: 'Water now' }).click();
  expect((await started).status()).toBe(202);
  await expect(control.getByText('Awaiting Arduino confirmation')).toBeVisible();
  await expect(control.getByText('RELAY OFF', { exact: true })).toBeVisible();
  const command = await publish();
  expect(command.mode).toBe('remote_on');
  await publish({ control_mode: 'remote_on', control_reason: 'remote_watering', irrigation_active: true, applied_command_id: command.command_id });
  await expect(control.getByText('RELAY ON', { exact: true })).toBeVisible();
  await expect(control.getByText('Confirmed by Arduino')).toBeVisible();
  // A rain interlock is reflected as an OFF relay even while a timed command exists.
  await publish({ rain_detected: true, irrigation_active: false, control_reason: 'rain_detected' });
  await expect(control.getByText('Rain detected: watering paused.')).toBeVisible();
  await publish({ control_mode: 'off', control_reason: 'connection_lost', rain_detected: false });
  await expect(control.getByText('Controller stopped this watering command')).toBeVisible();
  await expect(control.getByText('Server connection lost: remote watering stopped.')).toBeVisible();
  const stopped = page.waitForResponse((response) => response.url().endsWith('/api/irrigation/remote') && response.request().method() === 'POST');
  await control.getByRole('button', { name: 'Stop', exact: false }).click();
  expect((await stopped).status()).toBe(202);
  const stop = await publish();
  expect(stop.mode).toBe('off');
  await publish({ control_mode: 'off', control_reason: 'operator_stop', applied_command_id: stop.command_id, rain_detected: false });
  await expect(control.getByText('Watering stopped by operator.')).toBeVisible();
  await page.screenshot({ path: 'test-results/farmsense-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(control.getByRole('button', { name: 'Water now' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  // Once telemetry expires the UI must not continue claiming a confirmed relay state.
  clearInterval(heartbeat);
  await expect(control.getByText('OFFLINE', { exact: true })).toBeVisible({ timeout: 12000 });
  await expect(control.getByRole('button', { name: 'Water now' })).toBeDisabled();
  await page.screenshot({ path: 'test-results/farmsense-mobile.png', fullPage: true });
  await page.evaluate(() => window.localStorage.setItem('nxtyield-demo-mode', 'true'));
  await page.reload();
  await expect(control.getByText('Demo mode: hardware controls are disabled.')).toBeVisible();
  await control.getByLabel('Operator key').fill('e2e-operator-key-only-for-tests');
  for (const name of ['Auto', 'Water now', 'Stop']) {
    await expect(control.getByRole('button', { name, exact: false })).toBeDisabled();
  }
  } finally {
    clearInterval(heartbeat);
  }
});
