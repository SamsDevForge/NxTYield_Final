import { defineConfig } from '@playwright/test';
import process from 'node:process';

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  timeout: 45000,
  use: { baseURL: 'http://127.0.0.1:5174', trace: 'retain-on-failure',
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) },
  webServer: [
    { command: 'python -m uvicorn backend.app:app --host 127.0.0.1 --port 8001',
      url: 'http://127.0.0.1:8001/health', reuseExistingServer: false,
      env: { FARMSENSE_DEVICE_API_KEY: 'e2e-device-key-only-for-tests',
        FARMSENSE_DASHBOARD_API_KEY: 'e2e-dashboard-key-only-for-tests',
        FARMSENSE_DATABASE_PATH: './data/e2e.sqlite3', FARMSENSE_STALE_AFTER_SECONDS: '5' } },
    { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5174 --strictPort',
      url: 'http://127.0.0.1:5174', reuseExistingServer: false,
      env: { SENSOR_API_URL: 'http://127.0.0.1:8001/sensor-data',
        SENSOR_HISTORY_API_URL: 'http://127.0.0.1:8001/sensor-history',
        IRRIGATION_API_URL: 'http://127.0.0.1:8001/irrigation-active',
        FARMSENSE_API_KEY: 'e2e-dashboard-key-only-for-tests', IRRIGATION_CONTROL_KEY: 'e2e-operator-key-only-for-tests' } },
  ],
});
