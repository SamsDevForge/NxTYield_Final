from fastapi.testclient import TestClient
import pytest

from backend.app import Settings, create_app


DEVICE = {"Authorization": "Bearer test-device-key-123456789"}
DASHBOARD = {"Authorization": "Bearer test-dashboard-key-123456789"}


def packet(**changes):
    return {"device_id": "farmsense-01", "boot_id": "boot-1", "sequence": 1,
            "uptime_ms": 2000, "moisture": 30, "air_temperature": 26,
            "humidity": 58, "pressure": 1009.3, "rain_detected": False,
            "irrigation_active": False, "control_mode": "auto", "control_reason": "startup",
            **changes}


@pytest.fixture
def rig(tmp_path):
    now = [1800000000.0]
    settings = Settings(database_path=str(tmp_path / "farm.sqlite3"),
                        device_api_key=DEVICE["Authorization"][7:],
                        dashboard_api_key=DASHBOARD["Authorization"][7:], history_limit=3)
    app = create_app(settings, clock=lambda: now[0])
    with TestClient(app) as client:
        yield client, now, settings


def test_role_keys_and_wrong_device_cannot_control_or_publish(rig):
    client, _, _ = rig
    assert client.post("/telemetry", json=packet()).status_code == 401
    assert client.post("/telemetry", json=packet(), headers=DASHBOARD).status_code == 401
    assert client.get("/sensor-data", headers=DEVICE).status_code == 401
    assert client.post("/irrigation-active", json={"mode": "off"}, headers=DEVICE).status_code == 401
    assert client.post("/telemetry", json=packet(device_id="other"), headers=DEVICE).status_code == 403


def test_telemetry_round_trip_null_zero_and_staleness(rig):
    client, now, _ = rig
    assert client.get("/sensor-data", headers=DASHBOARD).json()["available"] is False
    response = client.post("/telemetry", json=packet(moisture=0, air_temperature=0), headers=DEVICE)
    assert response.status_code == 200
    reading = client.get("/sensor-data", headers=DASHBOARD).json()
    assert reading["moisture"] == 0 and reading["air_temperature"] == 0
    assert reading["humidity"] == 58 and reading["ph"] is None
    assert reading["source"] == "hardware" and reading["available"]
    assert client.get("/sensor-data", headers=DASHBOARD).headers["cache-control"] == "no-store"
    now[0] += 21
    stale = client.get("/sensor-data", headers=DASHBOARD).json()
    assert not stale["available"] and not stale["device_online"]
    historical = client.get("/sensor-history", headers=DASHBOARD).json()[0]
    assert historical["available"] and not historical["device_online"]


def test_duplicate_retry_does_not_refresh_last_seen_and_old_packets_rejected(rig):
    client, now, _ = rig
    client.post("/telemetry", json=packet(sequence=10), headers=DEVICE)
    now[0] += 30
    duplicate = client.post("/telemetry", json=packet(sequence=10), headers=DEVICE).json()
    assert duplicate["duplicate"]
    assert not client.get("/sensor-data", headers=DASHBOARD).json()["available"]
    assert client.post("/telemetry", json=packet(sequence=9), headers=DEVICE).status_code == 409
    assert len(client.get("/sensor-history", headers=DASHBOARD).json()) == 1


def test_command_delivery_acknowledgment_and_expiry_do_not_claim_pump_started(rig):
    client, now, _ = rig
    client.post("/telemetry", json=packet(), headers=DEVICE)
    response = client.post("/irrigation-active", json={"mode": "remote_on", "duration_seconds": 60}, headers=DASHBOARD)
    assert response.status_code == 202
    queued = response.json()
    assert queued["pending"] and not queued["applied"] and queued["actual_irrigation_active"] is False
    command = client.post("/telemetry", json=packet(sequence=2), headers=DEVICE).json()["command"]
    assert command["command_id"] == queued["command_id"] and command["mode"] == "remote_on"
    client.post("/telemetry", json=packet(sequence=3, applied_command_id=command["command_id"],
                control_mode="remote_on", control_reason="remote_watering", irrigation_active=True), headers=DEVICE)
    applied = client.get("/irrigation-active", headers=DASHBOARD).json()
    assert applied["applied"] and applied["actual_irrigation_active"] is True
    now[0] += 61
    expired = client.get("/device/command", headers=DEVICE).json()
    assert expired["mode"] == "off" and expired["remaining_seconds"] == 0
    assert expired["command_id"] == command["command_id"]  # Polls never renew a timed command.


def test_start_rejects_offline_rain_and_invalid_moisture_stop_still_queues(rig):
    client, _, _ = rig
    assert client.post("/irrigation-active", json={"mode": "remote_on"}, headers=DASHBOARD).status_code == 409
    client.post("/telemetry", json=packet(rain_detected=True), headers=DEVICE)
    assert client.post("/irrigation-active", json={"mode": "remote_on"}, headers=DASHBOARD).status_code == 409
    client.post("/telemetry", json=packet(sequence=2, moisture=None), headers=DEVICE)
    assert client.post("/irrigation-active", json={"mode": "remote_on"}, headers=DASHBOARD).status_code == 409
    stopped = client.post("/irrigation-active", json={"mode": "off"}, headers=DASHBOARD)
    assert stopped.status_code == 202 and stopped.json()["mode"] == "off"


def test_controller_reboot_cannot_restart_an_old_timed_command(rig):
    client, _, _ = rig
    client.post("/telemetry", json=packet(), headers=DEVICE)
    client.post("/irrigation-active", json={"mode": "remote_on"}, headers=DASHBOARD)
    rebooted = client.post("/telemetry", json=packet(boot_id="new-boot"), headers=DEVICE).json()
    assert rebooted["command"]["mode"] == "off" and rebooted["command"]["boot_changed"]


def test_offline_stop_is_pending_with_unknown_actual_relay_state(rig):
    client, now, _ = rig
    client.post("/telemetry", json=packet(), headers=DEVICE)
    now[0] += 25
    status = client.post("/irrigation-active", json={"mode": "off"}, headers=DASHBOARD).json()
    assert status["pending"] and status["actual_irrigation_active"] is None
    assert not status["device_online"]


def test_controller_timeout_reports_a_stopped_command_without_claiming_activation(rig):
    client, _, _ = rig
    client.post("/telemetry", json=packet(), headers=DEVICE)
    command = client.post("/irrigation-active", json={"mode": "remote_on"}, headers=DASHBOARD).json()
    client.post("/telemetry", json=packet(sequence=2, applied_command_id=command["command_id"],
                control_mode="off", control_reason="connection_lost"), headers=DEVICE)
    status = client.get("/irrigation-active", headers=DASHBOARD).json()
    assert status["reported_command_id"] == command["command_id"]
    assert status["reported_mode"] == "off" and status["control_reason"] == "connection_lost"
    assert status["actual_irrigation_active"] is False


@pytest.mark.parametrize("changes", [{"humidity": 101}, {"moisture": -1}, {"pressure": 0},
    {"ph": 6.5}, {"irrigation_active": "false"}, {"unexpected": 1}])
def test_invalid_sensor_data_is_rejected(rig, changes):
    client, _, _ = rig
    assert client.post("/telemetry", json=packet(**changes), headers=DEVICE).status_code == 422


@pytest.mark.parametrize("body", [True, {"mode": "on"}, {"mode": "remote_on", "duration_seconds": 301},
    {"mode": "remote_on", "duration_seconds": True}, {"mode": "remote_on", "duration_seconds": 0}])
def test_invalid_commands_are_rejected(rig, body):
    client, _, _ = rig
    assert client.post("/irrigation-active", json=body, headers=DASHBOARD).status_code == 422


def test_history_retention_and_restart_persist_commands_and_readings(rig):
    client, now, settings = rig
    for sequence in range(1, 6):
        client.post("/telemetry", json=packet(sequence=sequence), headers=DEVICE)
    history = client.get("/sensor-history?limit=2", headers=DASHBOARD).json()
    assert [item["sequence"] for item in history] == [4, 5]
    assert len(client.get("/sensor-history", headers=DASHBOARD).json()) == 3
    command = client.post("/irrigation-active", json={"mode": "off"}, headers=DASHBOARD).json()
    with TestClient(create_app(settings, clock=lambda: now[0])) as restarted:
        assert restarted.get("/sensor-data", headers=DASHBOARD).json()["sequence"] == 5
        assert restarted.get("/irrigation-active", headers=DASHBOARD).json()["command_id"] == command["command_id"]


def test_missing_keys_fail_startup(tmp_path):
    with pytest.raises(RuntimeError, match="API keys"):
        with TestClient(create_app(Settings(database_path=str(tmp_path / "unused.db")))):
            pass
