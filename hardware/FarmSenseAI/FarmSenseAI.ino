/*
 * NxTYield - FarmSense AI: reconstructed reference sketch.
 * Target: Arduino UNO R4 WiFi with BME280 (temperature, humidity, pressure).
 * Supplied by the project maintainer; not recovered event firmware.
 * See hardware/README.md for provenance, wiring and unverified NPK settings.
 * No WiFi/API bridge or physical pH reading is implemented in this reference.
 */

#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <LiquidCrystal_I2C.h>
#include <ModbusMaster.h>

// ---------------- PIN CONFIGURATION ----------------

#define SOIL_PIN A0
#define RAIN_PIN 2
#define DS18B20_PIN 3
#define RELAY_PIN 4

#define MAX485_DE_RE 5

// ---------------- OBJECTS ----------------

Adafruit_BME280 bme;

OneWire oneWire(DS18B20_PIN);
DallasTemperature soilTempSensor(&oneWire);

LiquidCrystal_I2C lcd(0x27, 16, 2);

ModbusMaster npk;

// ---------------- VARIABLES ----------------

// Soil moisture calibration
int dryValue = 800;
int wetValue = 350;

int soilMoisture = 0;

float soilTemperature = 0;
float airTemperature = 0;
float humidity = 0;
float pressure = 0;

int nitrogen = 0;
int phosphorus = 0;
int potassium = 0;

bool rainDetected = false;
bool irrigationActive = false;

// Change these if your relay is active LOW
#define RELAY_ON LOW
#define RELAY_OFF HIGH

// ---------------- RS485 CONTROL ----------------

void preTransmission() {
  digitalWrite(MAX485_DE_RE, HIGH);
}

void postTransmission() {
  digitalWrite(MAX485_DE_RE, LOW);
}

// ---------------- SETUP ----------------

void setup() {

  Serial.begin(115200);

  // Sensors
  pinMode(SOIL_PIN, INPUT);
  pinMode(RAIN_PIN, INPUT);

  // Relay
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, RELAY_OFF);

  // RS485
  pinMode(MAX485_DE_RE, OUTPUT);
  digitalWrite(MAX485_DE_RE, LOW);

  // Initialize sensors
  soilTempSensor.begin();

  if (!bme.begin(0x76)) {
    Serial.println("BME280 not detected!");
  }

  // LCD
  lcd.init();
  lcd.backlight();

  lcd.setCursor(0, 0);
  lcd.print("FarmSense AI");
  lcd.setCursor(0, 1);
  lcd.print("Initializing...");

  // NPK Modbus
  Serial1.begin(4800);

  npk.begin(1, Serial1);
  npk.preTransmission(preTransmission);
  npk.postTransmission(postTransmission);

  delay(2000);

  lcd.clear();

  Serial.println("FarmSense AI Started");
}

// ---------------- SOIL MOISTURE ----------------

void readSoilMoisture() {

  int rawValue = analogRead(SOIL_PIN);

  soilMoisture = map(
    rawValue,
    dryValue,
    wetValue,
    0,
    100
  );

  soilMoisture = constrain(soilMoisture, 0, 100);
}

// ---------------- SOIL TEMPERATURE ----------------

void readSoilTemperature() {

  soilTempSensor.requestTemperatures();

  soilTemperature =
    soilTempSensor.getTempCByIndex(0);

}

// ---------------- ENVIRONMENTAL DATA ----------------

void readEnvironment() {

  airTemperature = bme.readTemperature();

  humidity = bme.readHumidity();

  pressure = bme.readPressure() / 100.0F;

}

// ---------------- RAIN DETECTION ----------------

void readRain() {

  // Assumes LM393 digital output is LOW when rain is detected
  rainDetected = (digitalRead(RAIN_PIN) == LOW);

}

// ---------------- NPK SENSOR ----------------

void readNPK() {

  // Example register range only.
  // Confirm the register addresses and baud rate
  // against your particular NPK sensor protocol.

  uint8_t result = npk.readHoldingRegisters(0x001E, 3);

  if (result == npk.ku8MBSuccess) {

    nitrogen = npk.getResponseBuffer(0);
    phosphorus = npk.getResponseBuffer(1);
    potassium = npk.getResponseBuffer(2);

  } else {

    Serial.println("NPK communication error");

  }

}

// ---------------- IRRIGATION CONTROL ----------------

void controlIrrigation() {

  // Rain takes priority over irrigation.

  if (rainDetected) {

    irrigationActive = false;

  }

  else if (soilMoisture < 35) {

    irrigationActive = true;

  }

  else {

    irrigationActive = false;

  }

  digitalWrite(
    RELAY_PIN,
    irrigationActive ? RELAY_ON : RELAY_OFF
  );

}

// ---------------- LCD DISPLAY ----------------

void updateLCD() {

  lcd.clear();

  lcd.setCursor(0, 0);

  lcd.print("Soil:");
  lcd.print(soilMoisture);
  lcd.print("% ");

  lcd.print("T:");
  lcd.print(soilTemperature, 1);

  lcd.setCursor(0, 1);

  if (rainDetected) {

    lcd.print("Rain Detected");

  }

  else if (irrigationActive) {

    lcd.print("Pump: ON");

  }

  else {

    lcd.print("Pump: OFF");

  }

}

// ---------------- SERIAL DATA ----------------

void sendData() {

  Serial.println("-------- FARMSENSE AI --------");

  Serial.print("Soil Moisture: ");
  Serial.print(soilMoisture);
  Serial.println("%");

  Serial.print("Soil Temperature: ");
  Serial.println(soilTemperature);

  Serial.print("Air Temperature: ");
  Serial.println(airTemperature);

  Serial.print("Humidity: ");
  Serial.println(humidity);

  Serial.print("Pressure: ");
  Serial.println(pressure);

  Serial.print("Nitrogen: ");
  Serial.println(nitrogen);

  Serial.print("Phosphorus: ");
  Serial.println(phosphorus);

  Serial.print("Potassium: ");
  Serial.println(potassium);

  Serial.print("Rain: ");
  Serial.println(rainDetected ? "YES" : "NO");

  Serial.print("Irrigation: ");
  Serial.println(irrigationActive ? "ON" : "OFF");

  Serial.println("------------------------------");

}

// ---------------- MAIN LOOP ----------------

void loop() {

  readSoilMoisture();

  readSoilTemperature();

  readEnvironment();

  readRain();

  readNPK();

  controlIrrigation();

  updateLCD();

  sendData();

  delay(2000);

}
