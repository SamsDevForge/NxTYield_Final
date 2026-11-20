/*
 * NxTYield / FarmSense AI - UNO R4 WiFi HTTP controller.
 * Extended from the maintainer's reconstructed sketch; not archived event firmware.
 * BME280 temperature/humidity/pressure, JSON telemetry, and leased remote watering.
 * Configure arduino_secrets.h and verify the wiring/calibration in hardware/README.md.
 */
#include <Wire.h>
#include <Adafruit_BME280.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <LiquidCrystal_I2C.h>
#include <ModbusMaster.h>
#include <WiFiS3.h>
#include <ArduinoHttpClient.h>
#include <ArduinoJson.h>
#include <math.h>

#if __has_include("arduino_secrets.h")
#include "arduino_secrets.h"
#else
#include "arduino_secrets.example.h"
#endif

constexpr uint8_t SOIL_PIN = A0, RAIN_PIN = 2, DS18B20_PIN = 3;
constexpr uint8_t RELAY_PIN = 4, MAX485_DE_RE = 5;
constexpr uint8_t RELAY_ON = LOW, RELAY_OFF = HIGH;  // Match the actual relay.
constexpr int DRY_VALUE = 800, WET_VALUE = 350;
constexpr int AUTO_START_PERCENT = 35, AUTO_STOP_PERCENT = 45;
constexpr uint32_t SAMPLE_INTERVAL_MS = 2000, WIFI_RETRY_MS = 10000;
constexpr uint32_t REMOTE_LINK_TIMEOUT_MS = 15000, MAX_PUMP_RUN_MS = 300000;
// These are example protocol settings. Enable only after checking the exact probe.
constexpr bool NPK_PROTOCOL_CONFIRMED = false;
constexpr uint16_t NPK_FIRST_REGISTER = 0x001E;

Adafruit_BME280 bme;
OneWire oneWire(DS18B20_PIN);
DallasTemperature soilTempSensor(&oneWire);
LiquidCrystal_I2C lcd(0x27, 16, 2);
ModbusMaster npk;
#if FARMSENSE_USE_TLS
WiFiSSLClient network;
#else
WiFiClient network;
#endif
HttpClient http(network, FARMSENSE_HOST, FARMSENSE_PORT);

bool bmeReady = false, moistureValid = false, npkValid = false;
bool rainDetected = false, irrigationActive = false, runtimeLocked = false;
int soilMoisture = 0, nitrogen = 0, phosphorus = 0, potassium = 0;
float soilTemperature = NAN, airTemperature = NAN, humidity = NAN, pressure = NAN;
String bootId, appliedCommandId, controlMode = "off";
const char* controlReason = "startup";
const char* offReason = "startup";
uint32_t sequenceNumber = 0, lastSampleAt = 0, lastWifiAttemptAt = 0;
uint32_t lastServerAt = 0, pumpStartedAt = 0, remoteStartedAt = 0, remoteBudgetMs = 0;

void preTransmission() { digitalWrite(MAX485_DE_RE, HIGH); }
void postTransmission() { digitalWrite(MAX485_DE_RE, LOW); }

void setPump(bool active) {
  if (active && !irrigationActive) pumpStartedAt = millis();
  irrigationActive = active;
  digitalWrite(RELAY_PIN, active ? RELAY_ON : RELAY_OFF);
}

void controlIrrigation() {
  const uint32_t now = millis();
  rainDetected = digitalRead(RAIN_PIN) == LOW;
  if (controlMode == "remote_on") {
    if (now - remoteStartedAt >= remoteBudgetMs) {
      controlMode = "off";
      offReason = "command_expired";
    } else if (now - lastServerAt >= REMOTE_LINK_TIMEOUT_MS) {
      controlMode = "off";
      offReason = "connection_lost";
    }
  }
  if (irrigationActive && now - pumpStartedAt >= MAX_PUMP_RUN_MS) runtimeLocked = true;
  if (controlMode == "auto" && moistureValid && soilMoisture >= AUTO_STOP_PERCENT) runtimeLocked = false;

  bool run = false;
  if (rainDetected) controlReason = "rain_detected";
  else if (controlMode == "off") controlReason = offReason;
  else if (!moistureValid) controlReason = "moisture_invalid";
  else if (runtimeLocked) controlReason = "runtime_limit";
  else if (controlMode == "remote_on") { run = true; controlReason = "remote_watering"; }
  else {
    run = soilMoisture < AUTO_START_PERCENT || (irrigationActive && soilMoisture < AUTO_STOP_PERCENT);
    controlReason = run ? "moisture_low" : "moisture_satisfied";
  }
  setPump(run);
}

void readSensors() {
  const int raw = analogRead(SOIL_PIN);
  moistureValid = raw > 0 && raw < 1023 && DRY_VALUE != WET_VALUE;
  soilMoisture = constrain(map(raw, DRY_VALUE, WET_VALUE, 0, 100), 0, 100);
  controlIrrigation();
  soilTempSensor.requestTemperatures();
  soilTemperature = soilTempSensor.getTempCByIndex(0);
  controlIrrigation();
  if (bmeReady) {
    airTemperature = bme.readTemperature();
    humidity = bme.readHumidity();
    pressure = bme.readPressure() / 100.0F;
  }
  npkValid = false;
  if (NPK_PROTOCOL_CONFIRMED && npk.readHoldingRegisters(NPK_FIRST_REGISTER, 3) == npk.ku8MBSuccess) {
    nitrogen = npk.getResponseBuffer(0);
    phosphorus = npk.getResponseBuffer(1);
    potassium = npk.getResponseBuffer(2);
    npkValid = true;
  }
  controlIrrigation();
}

void putReading(JsonDocument& doc, const char* key, float value, float minimum, float maximum) {
  if (isfinite(value) && value >= minimum && value <= maximum) doc[key] = value;
  else doc[key] = nullptr;
}

void applyCommand(JsonObjectConst command, uint32_t requestElapsedMs) {
  const String id = command["command_id"] | "";
  String mode = command["mode"] | "";
  if (id.length() == 0 || id.length() > 64 || (mode != "off" && mode != "auto" && mode != "remote_on")) return;
  uint32_t seconds = command["remaining_seconds"] | 0U;
  if (seconds > 300) return;
  const String targetBoot = command["target_boot_id"] | "";
  if (mode == "remote_on" && targetBoot != bootId) mode = "off";
  const uint32_t offeredMs = seconds * 1000UL;
  const uint32_t budget = offeredMs > requestElapsedMs ? offeredMs - requestElapsedMs : 0;

  if (id != appliedCommandId) {
    appliedCommandId = id;
    controlMode = mode;
    runtimeLocked = false;
    remoteStartedAt = millis();
    remoteBudgetMs = budget;
    offReason = command["expired"].as<bool>() ? "command_expired" : "operator_stop";
  } else if (mode == "off") {
    controlMode = "off";
    if (command["expired"].as<bool>()) offReason = "command_expired";
  } else if (controlMode == "remote_on") {
    // Receiving the same command cannot extend or restart its local timer.
    const uint32_t elapsed = millis() - remoteStartedAt;
    remoteBudgetMs = min(remoteBudgetMs, elapsed + budget);
  }
  controlIrrigation();
}

void publishTelemetry() {
  if (WiFi.status() != WL_CONNECTED) return;
  JsonDocument doc;
  doc["device_id"] = FARMSENSE_DEVICE_ID;
  doc["boot_id"] = bootId;
  doc["sequence"] = sequenceNumber++;
  doc["uptime_ms"] = millis();
  if (moistureValid) doc["moisture"] = soilMoisture;
  else doc["moisture"] = nullptr;
  putReading(doc, "soil_temperature", soilTemperature, -55, 125);
  putReading(doc, "air_temperature", airTemperature, -40, 85);
  putReading(doc, "humidity", humidity, 0, 100);
  putReading(doc, "pressure", pressure, 300, 1100);
  if (npkValid) {
    doc["nitrogen"] = nitrogen; doc["phosphorus"] = phosphorus; doc["potassium"] = potassium;
  } else {
    doc["nitrogen"] = nullptr; doc["phosphorus"] = nullptr; doc["potassium"] = nullptr;
  }
  doc["ph"] = nullptr;
  doc["rain_detected"] = rainDetected;
  doc["irrigation_active"] = irrigationActive;
  doc["control_mode"] = controlMode;
  doc["control_reason"] = controlReason;
  if (appliedCommandId.length()) doc["applied_command_id"] = appliedCommandId;
  else doc["applied_command_id"] = nullptr;
  JsonArray errors = doc["sensor_errors"].to<JsonArray>();
  if (!moistureValid) errors.add("moisture_invalid");
  if (doc["soil_temperature"].isNull()) errors.add("soil_temperature_unavailable");
  if (!bmeReady || doc["air_temperature"].isNull() || doc["humidity"].isNull() || doc["pressure"].isNull()) errors.add("bme280_unavailable");
  if (!npkValid) errors.add(NPK_PROTOCOL_CONFIRMED ? "npk_read_failed" : "npk_protocol_unverified");
  String payload;
  serializeJson(doc, payload);
  Serial.println(payload);

  const uint32_t started = millis();
  http.beginRequest();
  http.post("/telemetry");
  http.sendHeader("Content-Type", "application/json");
  http.sendHeader("Authorization", String("Bearer ") + FARMSENSE_DEVICE_API_KEY);
  http.sendHeader("Content-Length", payload.length());
  http.beginBody();
  http.print(payload);
  http.endRequest();
  const int code = http.responseStatusCode();
  const String body = http.responseBody();
  http.stop();
  controlIrrigation();
  if (code != 200) { Serial.print("Telemetry HTTP status: "); Serial.println(code); return; }
  JsonDocument response;
  if (deserializeJson(response, body) || response["accepted"] != true || !response["command"].is<JsonObject>()) return;
  lastServerAt = millis();
  applyCommand(response["command"].as<JsonObjectConst>(), millis() - started);
}

void updateLCD() {
  lcd.setCursor(0, 0);
  lcd.print("Soil:");
  if (moistureValid) lcd.print(soilMoisture); else lcd.print("--");
  lcd.print("% T:");
  if (isfinite(soilTemperature) && soilTemperature >= -55) lcd.print(soilTemperature, 1); else lcd.print("--");
  lcd.print("    ");
  lcd.setCursor(0, 1);
  if (rainDetected) lcd.print("Rain: pump OFF  ");
  else if (irrigationActive) lcd.print("Pump ON         ");
  else lcd.print("Pump OFF        ");
}

void setup() {
  // Establish the off level before enabling the relay output.
  digitalWrite(RELAY_PIN, RELAY_OFF);
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(SOIL_PIN, INPUT); pinMode(RAIN_PIN, INPUT);
  pinMode(MAX485_DE_RE, OUTPUT); digitalWrite(MAX485_DE_RE, LOW);
  Serial.begin(115200);
  analogReadResolution(10);
  Wire.begin();
  soilTempSensor.begin();
  bmeReady = bme.begin(0x76) || bme.begin(0x77);
  lcd.init(); lcd.backlight();
  Serial1.begin(4800);
  npk.begin(1, Serial1); npk.preTransmission(preTransmission); npk.postTransmission(postTransmission);
  http.setHttpResponseTimeout(2500);
  network.setConnectionTimeout(2500);
  WiFi.setTimeout(2500);
  // Boot identity binds timed commands to this running controller session.
  randomSeed(analogRead(A1) ^ micros());
  bootId = String(static_cast<uint32_t>(random(0x7fffffff)), HEX) + "-" + String(micros(), HEX);
  lastWifiAttemptAt = millis() - WIFI_RETRY_MS;
  lastSampleAt = millis() - SAMPLE_INTERVAL_MS;
  Serial.println("FarmSense HTTP controller ready; relay starts OFF.");
}

void loop() {
  controlIrrigation();
  const uint32_t now = millis();
  const bool configured = String(SECRET_SSID) != "CHANGE_ME" && String(FARMSENSE_DEVICE_API_KEY).length() >= 16;
  if (configured && now - lastWifiAttemptAt >= WIFI_RETRY_MS) {
    lastWifiAttemptAt = now;
    if (WiFi.status() != WL_CONNECTED) WiFi.begin(SECRET_SSID, SECRET_PASS);
    controlIrrigation();
  }
  if (millis() - lastSampleAt >= SAMPLE_INTERVAL_MS) {
    lastSampleAt = millis();
    readSensors();
    publishTelemetry();
    updateLCD();
  }
  controlIrrigation();
  delay(5);
}
