import { timingSafeEqual } from 'node:crypto';
import { fetchRemoteIrrigation, json, methodNotAllowed, readBody, sendRemoteIrrigation } from '../../server/apiUtils.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return json(res, 200, await fetchRemoteIrrigation());
  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  const expected = process.env.IRRIGATION_CONTROL_KEY;
  if (!expected || expected.length < 16) {
    return json(res, 503, { available: false, message: 'Remote control requires IRRIGATION_CONTROL_KEY on the server.' });
  }
  const supplied = req.headers?.authorization?.replace(/^Bearer /i, '') || '';
  const actualBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    return json(res, 401, { available: false, message: 'Enter a valid operator key to control watering.' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { available: false, message: 'Send a JSON irrigation command.' });
  }
  if (!['auto', 'off', 'remote_on'].includes(body?.mode)
      || (body.mode === 'remote_on' && (!Number.isInteger(body.duration_seconds) || body.duration_seconds < 5 || body.duration_seconds > 300))) {
    return json(res, 400, { available: false, message: 'Use auto, off, or remote_on with a duration of 5–300 seconds.' });
  }
  try {
    const command = { mode: body.mode, ...(body.mode === 'remote_on' ? { duration_seconds: body.duration_seconds } : {}) };
    return json(res, 202, await sendRemoteIrrigation(command));
  } catch (error) {
    return json(res, error.status || 502, { available: false, message: error.message || 'Irrigation server unavailable' });
  }
}
