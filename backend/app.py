"""One FarmSense controller, persistent telemetry, and acknowledged pump commands."""

from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import secrets
import sqlite3
import time
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, HTTPException, Query, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field


@dataclass(frozen=True)
class Settings:
    database_path: str = "./data/farmsense.sqlite3"
    device_id: str = "farmsense-01"
    device_api_key: str = ""
    dashboard_api_key: str = ""
    stale_after_seconds: int = 20
    history_limit: int = 10000

    @classmethod
    def from_env(cls):
        return cls(
            database_path=os.getenv("FARMSENSE_DATABASE_PATH", cls.database_path),
            device_id=os.getenv("FARMSENSE_DEVICE_ID", cls.device_id),
            device_api_key=os.getenv("FARMSENSE_DEVICE_API_KEY", ""),
            dashboard_api_key=os.getenv("FARMSENSE_DASHBOARD_API_KEY", ""),
            stale_after_seconds=int(os.getenv("FARMSENSE_STALE_AFTER_SECONDS", "20")),
        )

    def validate(self):
        if min(len(self.device_api_key), len(self.dashboard_api_key)) < 16:
            raise RuntimeError("Set distinct FarmSense device and dashboard API keys (16+ characters).")
        if self.device_api_key == self.dashboard_api_key:
            raise RuntimeError("Device and dashboard API keys must differ.")
        if self.stale_after_seconds < 5 or self.history_limit < 1:
            raise RuntimeError("Invalid telemetry freshness or retention configuration.")


Reading = Annotated[float, Field(strict=True, allow_inf_nan=False)]
Identifier = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")]


class Telemetry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    device_id: Identifier
    boot_id: Identifier
    sequence: int = Field(ge=0, strict=True)
    uptime_ms: int = Field(ge=0, le=4294967295, strict=True)
    moisture: Reading | None = Field(default=None, ge=0, le=100)
    soil_temperature: Reading | None = Field(default=None, ge=-55, le=125)
    air_temperature: Reading | None = Field(default=None, ge=-40, le=85)
    humidity: Reading | None = Field(default=None, ge=0, le=100)
    pressure: Reading | None = Field(default=None, ge=300, le=1100)
    nitrogen: int | None = Field(default=None, ge=0, le=65535, strict=True)
    phosphorus: int | None = Field(default=None, ge=0, le=65535, strict=True)
    potassium: int | None = Field(default=None, ge=0, le=65535, strict=True)
    ph: None = None  # No working pH probe: a simulated value is not hardware telemetry.
    rain_detected: bool = Field(strict=True)
    irrigation_active: bool = Field(strict=True)  # Relay output, not a flow-sensor confirmation.
    control_mode: Literal["auto", "off", "remote_on"]
    control_reason: str = Field(max_length=80)
    applied_command_id: Identifier | None = None
    sensor_errors: list[Annotated[str, Field(max_length=100)]] = Field(default_factory=list, max_length=10)


class IrrigationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["auto", "off", "remote_on"]
    duration_seconds: int = Field(default=60, ge=5, le=300, strict=True)


def iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")


class Store:
    def __init__(self, settings):
        self.settings = settings

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.settings.database_path, timeout=10)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def initialize(self):
        Path(self.settings.database_path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS telemetry (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    boot_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    received_at REAL NOT NULL,
                    payload TEXT NOT NULL,
                    UNIQUE(boot_id, sequence)
                );
                CREATE TABLE IF NOT EXISTS command (
                    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                    command_id TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    updated_at REAL NOT NULL,
                    expires_at REAL,
                    target_boot_id TEXT
                );
            """)
            db.execute("INSERT OR IGNORE INTO command VALUES (1, ?, 'auto', ?, NULL, NULL)",
                       (secrets.token_hex(16), time.time()))

    def save(self, packet, now):
        with self.connect() as db:
            # Serialize writers so two simultaneous samples cannot reverse sequence order.
            db.execute("BEGIN IMMEDIATE")
            duplicate = db.execute("SELECT id FROM telemetry WHERE boot_id=? AND sequence=?",
                                   (packet.boot_id, packet.sequence)).fetchone()
            if duplicate:
                return True  # A retry never refreshes last-seen time or duplicates history.
            previous = db.execute("SELECT MAX(sequence) FROM telemetry WHERE boot_id=?",
                                  (packet.boot_id,)).fetchone()[0]
            if previous is not None and packet.sequence <= previous:
                raise HTTPException(409, "Out-of-order telemetry sequence")
            db.execute("INSERT INTO telemetry (boot_id, sequence, received_at, payload) VALUES (?, ?, ?, ?)",
                       (packet.boot_id, packet.sequence, now, packet.model_dump_json()))
            db.execute("DELETE FROM telemetry WHERE id NOT IN (SELECT id FROM telemetry ORDER BY id DESC LIMIT ?)",
                       (self.settings.history_limit,))
        return False

    def latest_row(self):
        with self.connect() as db:
            return db.execute("SELECT * FROM telemetry ORDER BY id DESC LIMIT 1").fetchone()

    def reading(self, row, now, historical=False):
        if row is None:
            return {"available": False, "provider": "farmsense", "source": "none",
                    "device_online": False, "message": "Waiting for Arduino telemetry"}
        age = max(0, now - row["received_at"])
        online = age <= self.settings.stale_after_seconds
        fresh = historical or online
        return {**json.loads(row["payload"]), "available": fresh, "provider": "farmsense",
                "source": "hardware", "timestamp": iso(row["received_at"]),
                "received_at": iso(row["received_at"]), "age_seconds": round(age, 1),
                "device_online": online, "message": None if fresh else "Arduino telemetry is stale"}

    def command(self, now):
        with self.connect() as db:
            row = db.execute("SELECT * FROM command WHERE singleton=1").fetchone()
        expired = row["expires_at"] is not None and now >= row["expires_at"]
        latest = self.latest_row()
        boot_changed = (row["mode"] == "remote_on" and latest is not None
                        and json.loads(latest["payload"])["boot_id"] != row["target_boot_id"])
        mode = "off" if expired or boot_changed else row["mode"]
        return {"command_id": row["command_id"], "mode": mode,
                "requested_mode": row["mode"], "enabled": mode == "remote_on",
                "updated_at": iso(row["updated_at"]),
                "expires_at": iso(row["expires_at"]) if row["expires_at"] else None,
                "remaining_seconds": max(0, math.floor(row["expires_at"] - now)) if row["expires_at"] else 0,
                "expired": expired, "target_boot_id": row["target_boot_id"], "boot_changed": boot_changed}

    def set_command(self, request, now, target_boot_id=None):
        expires = now + request.duration_seconds if request.mode == "remote_on" else None
        with self.connect() as db:
            db.execute("UPDATE command SET command_id=?, mode=?, updated_at=?, expires_at=?, target_boot_id=? WHERE singleton=1",
                       (secrets.token_hex(16), request.mode, now, expires, target_boot_id))

    def irrigation_status(self, now):
        command = self.command(now)
        latest = self.reading(self.latest_row(), now)
        online = latest["device_online"]
        applied = (online and latest.get("applied_command_id") == command["command_id"]
                   and latest.get("control_mode") == command["mode"])
        return {**command, "available": True, "provider": "farmsense", "device_online": online,
                "applied": applied, "pending": not applied,
                "actual_irrigation_active": latest.get("irrigation_active") if online else None,
                "reported_command_id": latest.get("applied_command_id") if online else None,
                "reported_mode": latest.get("control_mode") if online else None,
                "control_reason": latest.get("control_reason") if online else "device_offline",
                "last_seen": latest.get("timestamp"), "message": None}


def create_app(settings=None, clock=time.time):
    settings = settings or Settings.from_env()
    store = Store(settings)

    @asynccontextmanager
    async def lifespan(_app):
        settings.validate()
        store.initialize()
        yield

    app = FastAPI(title="NxTYield FarmSense API", version="1.0.0", lifespan=lifespan)
    bearer = HTTPBearer(auto_error=False)

    def authorize(credentials, expected):
        if credentials is None or not secrets.compare_digest(credentials.credentials.encode(), expected.encode()):
            raise HTTPException(401, "Invalid API key", headers={"WWW-Authenticate": "Bearer"})

    def device_auth(credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]):
        authorize(credentials, settings.device_api_key)

    def dashboard_auth(credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]):
        authorize(credentials, settings.dashboard_api_key)

    @app.middleware("http")
    async def no_cache(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/health")
    def health():
        with store.connect() as db:
            db.execute("SELECT 1")
        return {"status": "ok", "device_online": store.reading(store.latest_row(), clock())["device_online"]}

    @app.post("/telemetry", dependencies=[Depends(device_auth)])
    def telemetry(packet: Telemetry):
        if packet.device_id != settings.device_id:
            raise HTTPException(403, "Device ID does not match this controller")
        now = clock()
        duplicate = store.save(packet, now)
        return {"accepted": True, "duplicate": duplicate, "server_time": iso(now),
                "command": store.command(now)}

    @app.get("/device/command", dependencies=[Depends(device_auth)])
    def device_command():
        return store.command(clock())

    @app.get("/sensor-data", dependencies=[Depends(dashboard_auth)])
    def sensor_data():
        return store.reading(store.latest_row(), clock())

    @app.get("/sensor-history", dependencies=[Depends(dashboard_auth)])
    def sensor_history(limit: Annotated[int, Query(ge=1, le=1000)] = 60):
        with store.connect() as db:
            rows = db.execute("SELECT * FROM telemetry ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [store.reading(row, clock(), historical=True) for row in reversed(rows)]

    @app.get("/irrigation-active", dependencies=[Depends(dashboard_auth)])
    def irrigation_status():
        return store.irrigation_status(clock())

    @app.post("/irrigation-active", dependencies=[Depends(dashboard_auth)])
    def irrigation_command(command: IrrigationRequest, response: Response):
        now = clock()
        target_boot_id = None
        if command.mode == "remote_on":
            latest = store.reading(store.latest_row(), now)
            if not latest["device_online"]:
                raise HTTPException(409, "Arduino is offline; remote start was not queued")
            if latest.get("rain_detected") or latest.get("moisture") is None:
                raise HTTPException(409, "Remote start blocked by rain or an unavailable moisture sensor")
            target_boot_id = latest["boot_id"]
        store.set_command(command, now, target_boot_id)
        response.status_code = 202  # Accepted by server, not confirmed by hardware yet.
        return store.irrigation_status(now)

    return app


app = create_app()
