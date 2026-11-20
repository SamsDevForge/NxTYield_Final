export function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

export const DEFAULT_SENSOR_API_URL = 'http://127.0.0.1:8000/sensor-data';
export const DEFAULT_CROP_MODEL_API_URL = 'https://crop-model-api-1.onrender.com/predict';
export const DEFAULT_IRRIGATION_API_URL = 'http://127.0.0.1:8000/irrigation-active';

export function methodNotAllowed(res, methods) {
  res.setHeader('Allow', methods.join(', '));
  json(res, 405, { available: false, message: `Use ${methods.join(' or ')}` });
}

export function publicErrorMessage(error, secrets = []) {
  let message = error?.message || String(error || 'Unknown error');
  secrets.filter(Boolean).forEach((secret) => {
    message = message.replaceAll(secret, '[redacted]');
  });
  return message;
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export function unavailable(provider, message, extra = {}) {
  return {
    available: false,
    provider,
    message,
    ...extra,
  };
}

export async function farmSenseFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    cache: 'no-store',
    signal: AbortSignal.timeout(7000),
    headers: {
      ...options.headers,
      ...(process.env.FARMSENSE_API_KEY ? { Authorization: `Bearer ${process.env.FARMSENSE_API_KEY}` } : {}),
    },
  });
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toBoolean(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Boolean(value);
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return null;
}

function hasMeaningfulSensorValues(reading) {
  return [
    'nitrogen',
    'phosphorus',
    'potassium',
    'moisture',
    'ph',
    'soil_temperature',
    'air_temperature',
    'humidity',
    'pressure',
    'health_score',
  ].some((key) => {
    const value = toNumber(reading[key]);
    return value !== null;
  }) || typeof reading.rain_detected === 'boolean' || typeof reading.irrigation_active === 'boolean';
}

export function normalizeSensorPayload(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const reading = {
    nitrogen: toNumber(data?.nitrogen ?? data?.N),
    phosphorus: toNumber(data?.phosphorus ?? data?.P),
    potassium: toNumber(data?.potassium ?? data?.K),
    moisture: toNumber(data?.moisture ?? data?.soil_moisture ?? data?.soilMoisture),
    ph: toNumber(data?.ph ?? data?.pH ?? data?.soil_ph ?? data?.soil_pH ?? data?.soilPh),
    soil_temperature: toNumber(data?.soil_temperature ?? data?.soilTemperature),
    air_temperature: toNumber(data?.air_temperature ?? data?.airTemperature ?? data?.temperature),
    humidity: toNumber(data?.humidity),
    pressure: toNumber(data?.pressure),
    rain_detected: toBoolean(data?.rain_detected ?? data?.rainDetected),
    irrigation_active: toBoolean(data?.irrigation_active ?? data?.irrigationActive),
    health_score: toNumber(data?.health_score ?? data?.healthScore),
    timestamp: payload?.received_at || data?.timestamp || null,
    source: data?.source || payload?.source || 'hardware',
    device_online: payload?.device_online ?? data?.device_online ?? null,
    age_seconds: payload?.age_seconds ?? data?.age_seconds ?? null,
    applied_command_id: data?.applied_command_id ?? null,
    control_mode: data?.control_mode ?? null,
    control_reason: data?.control_reason ?? null,
    sensor_errors: data?.sensor_errors || [],
  };

  if (payload?.available === false || data?.available === false) {
    return unavailable('sensor', payload?.message || data?.message || 'Arduino telemetry unavailable', reading);
  }

  if (!hasMeaningfulSensorValues(reading)) {
    return unavailable('sensor', 'Sensor API not available. No usable telemetry returned.', {
      ...reading,
      source: 'none',
    });
  }

  return {
    ...reading,
    available: true,
    provider: 'sensor',
    message: null,
  };
}

export async function fetchSensorLatest() {
  const url = process.env.SENSOR_API_URL || DEFAULT_SENSOR_API_URL;
  if (!url) {
    return unavailable('sensor', 'Set SENSOR_API_URL in Vercel environment variables.', {
      source: 'none',
    });
  }

  try {
    const response = await farmSenseFetch(url);
    if (!response.ok) throw new Error(`Sensor API returned ${response.status}`);
    return normalizeSensorPayload(await response.json());
  } catch (error) {
    return unavailable('sensor', `Sensor API not available: ${publicErrorMessage(error)}`, {
      source: 'none',
    });
  }
}

function normalizeIrrigationCommand(payload) {
  if (!payload || typeof payload !== 'object' || !['auto', 'off', 'remote_on'].includes(payload.mode)) {
    throw new Error('Irrigation server returned an invalid command state');
  }
  return {
    ...payload,
    available: payload?.available !== false,
    enabled: payload?.mode === 'remote_on',
    mode: payload?.mode || 'off',
    updated_at: payload?.updated_at || null,
    actual_irrigation_active: payload?.actual_irrigation_active ?? null,
    applied: payload?.applied === true,
    pending: payload?.pending !== false,
    device_online: payload?.device_online === true,
  };
}

function irrigationApiUrl() {
  return process.env.IRRIGATION_API_URL || DEFAULT_IRRIGATION_API_URL;
}

export async function fetchRemoteIrrigation() {
  const url = irrigationApiUrl();
  try {
    const response = await farmSenseFetch(url);
    if (!response.ok) throw new Error(`Irrigation API returned ${response.status}`);
    return normalizeIrrigationCommand(await response.json());
  } catch (error) {
    return unavailable('irrigation', `Irrigation API not available: ${publicErrorMessage(error)}`, {
      enabled: false,
      mode: 'off',
      actual_irrigation_active: null,
      device_online: false,
      updated_at: null,
    });
  }
}

export async function sendRemoteIrrigation(command) {
  const url = irrigationApiUrl();
  const response = await farmSenseFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(typeof payload.detail === 'string' ? payload.detail : `Irrigation API returned ${response.status}`);
    error.status = response.status === 409 ? 409 : 502;
    throw error;
  }
  return normalizeIrrigationCommand(payload);
}

export function normalizeCropPrediction(value) {
  if (value && typeof value === 'object') {
    return value.prediction ?? value.crop ?? value.result ?? value.recommended_crop ?? value;
  }
  return typeof value === 'string' ? value.trim().replace(/^['"]|['"]$/g, '') : value;
}
