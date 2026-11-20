import { DEFAULT_CROP_MODEL_API_URL, DEFAULT_SENSOR_API_URL, json } from '../server/apiUtils.js';

export default function handler(req, res) {
  const sensorApiUrl = process.env.SENSOR_API_URL || DEFAULT_SENSOR_API_URL;
  const cropModelApiUrl = process.env.CROP_MODEL_API_URL || DEFAULT_CROP_MODEL_API_URL;

  json(res, 200, {
    status: 'ok',
    timestamp: new Date().toISOString(),
    demo_mode: false,
    sensor_api: {
      available: null,
      configured: Boolean(sensorApiUrl),
      using_default: !process.env.SENSOR_API_URL,
      url: sensorApiUrl || null,
      message: 'FarmSense telemetry service configured; availability comes from live sensor requests.',
    },
    weather_api: {
      available: true,
      configured: true,
      provider: process.env.OPENWEATHER_API_KEY ? 'openweather' : 'open-meteo',
      city: process.env.WEATHER_CITY || 'Pune,IN',
    },
    crop_model_api: {
      available: false,
      configured: Boolean(cropModelApiUrl),
      using_default: !process.env.CROP_MODEL_API_URL,
      url: cropModelApiUrl || null,
    },
    ai: {
      available: true,
      provider: process.env.GROQ_API_KEY ? 'groq' : 'local',
      message: process.env.GROQ_API_KEY ? null : 'Local farm assistant active.',
    },
  });
}
