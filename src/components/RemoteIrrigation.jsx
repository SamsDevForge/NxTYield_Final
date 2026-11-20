import { useEffect, useRef, useState } from 'react';
import { getRemoteIrrigation, setRemoteIrrigation } from '../lib/api';

const reasonLabels = {
  rain_detected: 'Rain detected: watering paused.',
  moisture_invalid: 'Moisture sensor unavailable: pump held off.',
  runtime_limit: 'Maximum continuous watering time reached.',
  command_expired: 'Timed watering finished. Select Auto to resume moisture control.',
  connection_lost: 'Server connection lost: remote watering stopped.',
  remote_watering: 'Arduino reports the relay is on for timed watering.',
  moisture_low: 'Automatic watering: soil moisture is low.',
  moisture_satisfied: 'Soil moisture is above the watering threshold.',
  operator_stop: 'Watering stopped by operator.',
  startup: 'Controller starting; pump is off.',
};

export default function RemoteIrrigation({ demoMode }) {
  const [status, setStatus] = useState(null);
  const [operatorKey, setOperatorKey] = useState('');
  const [duration, setDuration] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const revision = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer;
    async function poll() {
      const version = revision.current;
      try {
        const next = await getRemoteIrrigation();
        if (!cancelled && version === revision.current) setStatus(next);
      } catch (failure) {
        if (!cancelled && version === revision.current) {
          setStatus({ available: false, message: failure.message });
        }
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, 2000);
      }
    }
    poll();
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { cancelled = true; window.clearTimeout(timer); window.clearInterval(clock); };
  }, []);

  async function command(mode) {
    revision.current += 1;
    setBusy(true);
    setError('');
    try {
      const next = await setRemoteIrrigation(mode, duration, operatorKey);
      setStatus(next);
    } catch (failure) {
      setError(failure.message);
    } finally {
      revision.current += 1;
      setBusy(false);
    }
  }

  const online = status?.available !== false && status?.device_online === true;
  const pumpOn = online && status?.actual_irrigation_active === true;
  const remaining = status?.expires_at ? Math.max(0, Math.ceil((Date.parse(status.expires_at) - now) / 1000)) : 0;
  const disabled = busy || demoMode || operatorKey.length < 16;
  const modeLabel = { auto: 'Automatic moisture control', remote_on: 'Timed watering', off: 'Stopped' }[status?.mode] || 'Waiting for server';
  const stoppedLocally = online && status?.pending && status.reported_command_id === status.command_id
    && status.reported_mode === 'off' && status.mode === 'remote_on';
  const confirmation = !online ? 'Current relay state unknown' : stoppedLocally ? 'Controller stopped this watering command'
    : status?.pending ? 'Awaiting Arduino confirmation' : 'Confirmed by Arduino';
  let detail;
  if (demoMode) detail = 'Demo mode: hardware controls are disabled.';
  else if (error) detail = error;
  else if (busy) detail = 'Sending command…';
  else if (status?.available === false) detail = status.message;
  else if (!online) detail = 'Arduino offline. A stop command can be queued for reconnection.';
  else if (stoppedLocally) detail = reasonLabels[status.control_reason] || 'Watering held off by controller.';
  else if (status?.pending) detail = 'Command accepted by server; waiting for Arduino.';
  else detail = reasonLabels[status?.control_reason] || 'Controller connected.';

  return (
    <section className="irrigation-control" aria-label="Remote irrigation">
      <div className="irr-header">
        <span className="irr-label">Remote Irrigation</span>
        <span className={`irr-val ${pumpOn ? 'active' : ''}`}>
          {online ? pumpOn ? 'RELAY ON' : 'RELAY OFF' : 'OFFLINE'}
        </span>
      </div>
      <div className="irr-auto-row">
        <div className="irr-auto-copy">
          <span>{modeLabel}</span>
          <small>{confirmation}</small>
        </div>
        {status?.mode === 'remote_on' && <span className="irr-countdown">{remaining}s</span>}
      </div>
      <label className="irr-field">
        <span>Operator key</span>
        <input type="password" autoComplete="off" value={operatorKey}
          onChange={(event) => setOperatorKey(event.target.value)} placeholder="Enter key to unlock controls" />
      </label>
      <label className="irr-field">
        <span>Watering duration</span>
        <select value={duration} onChange={(event) => setDuration(Number(event.target.value))}>
          <option value={30}>30 seconds</option><option value={60}>1 minute</option>
          <option value={120}>2 minutes</option><option value={300}>5 minutes</option>
        </select>
      </label>
      <div className="irr-options irr-options-remote" role="group" aria-label="Watering commands">
        <button type="button" className={`irr-option ${status?.mode === 'auto' ? 'active' : ''}`} disabled={disabled} onClick={() => command('auto')}>
          <span>Auto</span><small>Moisture control</small>
        </button>
        <button type="button" className={`irr-option ${status?.mode === 'remote_on' ? 'active' : ''}`} disabled={disabled || !online || status?.available === false} onClick={() => command('remote_on')}>
          <span>Water now</span><small>Timed start</small>
        </button>
        <button type="button" className={`irr-option irr-stop ${status?.mode === 'off' ? 'active' : ''}`} disabled={disabled} onClick={() => command('off')}>
          <span>Stop</span><small>Hold pump off</small>
        </button>
      </div>
      <div className="irr-timer-detail" role="status" aria-live="polite">
        {detail}
      </div>
      <p className="irr-note">Relay status comes from the controller. Rain overrides watering. Keys stay in memory for this page.</p>
    </section>
  );
}
