import { DEFAULT_SENSOR_API_URL, farmSenseFetch, json, methodNotAllowed } from '../../server/apiUtils.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const url = process.env.SENSOR_HISTORY_API_URL || new URL('/sensor-history', process.env.SENSOR_API_URL || DEFAULT_SENSOR_API_URL).toString();
  if (!url) return json(res, 200, []);

  try {
    const response = await farmSenseFetch(url);
    if (!response.ok) throw new Error(`Sensor history API returned ${response.status}`);
    const data = await response.json();
    return json(res, 200, Array.isArray(data) ? data : []);
  } catch {
    return json(res, 200, []);
  }
}
