# FarmSense AI controller

Firmware for the **Arduino UNO R4 WiFi**, using **BME280** for air temperature, humidity and pressure. It reads the field sensors, drives a local LCD and relay, posts JSON telemetry to FastAPI, and applies commands returned by the server.

This code extends the maintainer-supplied reconstruction. It is not recovered event firmware. Board compilation and software tests are separate from physical sensor, wiring and pump validation.

## Hardware and pin map

| UNO R4 WiFi connection | Component / purpose |
| --- | --- |
| A0 | SEN0193 analog moisture output |
| D2 | LM393 rain digital output, LOW means rain |
| D3 | DS18B20 OneWire data |
| D4 | Relay input, active LOW in this sketch |
| D5 | MAX485 DE and /RE direction control |
| D0 / RX | MAX485 RO |
| D1 / TX | MAX485 DI |
| SDA / A4 | BME280 and 16×2 LCD SDA |
| SCL / A5 | BME280 and LCD SCL |

`Serial` is USB debugging at 115200 baud. `Serial1` is the D0/D1 NPK UART at 4800 baud. See the [UNO R4 manual](https://docs.arduino.cc/tutorials/uno-r4-wifi/cheat-sheet).

Match power, grounds, pull-ups and logic levels to the actual breakout modules, including the DS18B20 data pull-up. The bare BME280 is a low-voltage device; use a compatible breakout or level shifting with the UNO R4's 5 V interface. Check the [Bosch specifications](https://www.bosch-sensortec.com/en/products/environmental-sensors/humidity-sensors-bme280).

## Install and configure

1. Install **Arduino UNO R4 Boards** and select **Arduino UNO R4 WiFi**. The tested core is `arduino:renesas_uno@1.6.0`.
2. Install these libraries in Arduino IDE's Library Manager:

   | Library | Version used by CI |
   | --- | --- |
   | Adafruit BME280 Library | 2.3.0 |
   | Adafruit Unified Sensor / Adafruit BusIO | Installed as BME280 dependencies |
   | OneWire | 2.3.8 |
   | DallasTemperature | 4.0.6 |
   | LiquidCrystal I2C | 1.1.2 |
   | ModbusMaster | 2.0.1 |
   | ArduinoHttpClient | 0.6.2 |
   | ArduinoJson | 7.4.3 (version 7 API) |

   WiFiS3/WiFiSSLClient come with the board core. The LCD library declares AVR support and emits a warning on this board; compilation is checked, but the actual backpack still needs testing.

3. Open [FarmSenseAI/FarmSenseAI.ino](FarmSenseAI/FarmSenseAI.ino).
4. Copy [arduino_secrets.example.h](FarmSenseAI/arduino_secrets.example.h) to **`arduino_secrets.h`** in the same folder. The real file is gitignored. Without it the sketch compiles with placeholders and does not join WiFi.
5. Configure WiFi, device ID, device API key, hostname, port and TLS. Use the [backend setup guide](../backend/README.md) to match the keys and addresses.
6. Verify configuration and compile before upload:

   ```bash
   arduino-cli compile --fqbn arduino:renesas_uno:unor4wifi hardware/FarmSenseAI
   ```

Keep a pump disconnected while validating relay polarity and sensor behavior.

## Calibration and protocol settings

| Setting | Default | What to verify |
| --- | --- | --- |
| ADC resolution | 10 bits | Explicitly configured for this calibration |
| Moisture dry / wet | 800 / 350 | Measure both values with the installed SEN0193 |
| BME280 address | Try 0x76, then 0x77 | Actual sensor address and voltage compatibility |
| LCD address | 0x27 | Actual I2C backpack address |
| Rain / relay polarity | Active LOW | Match the installed modules |
| NPK UART / slave | 4800 baud / slave 1 | Exact probe settings, including serial format |
| NPK register | 0x001E, three holding registers | **Example only:** confirm address, order, scaling and nutrient units |
| NPK enabled | `NPK_PROTOCOL_CONFIRMED = false` | Enable only after the protocol and data interpretation are confirmed |

Moisture is a relative 0–100% calibration, not volumetric water content. ADC rail readings are rejected; this does not detect every possible sensor failure.

NPK communication failures emit null values rather than reusing an older sample. Confirm the probe's register units/scaling against the dashboard's nutrient units before enabling it; adapt conversion code if required. The pH probe was not working in the prototype, so firmware always sends `ph: null`.

## Irrigation control

| Condition / mode | Relay behavior |
| --- | --- |
| Startup | OFF until the first valid server command |
| Rain detected | OFF in every mode |
| Moisture unavailable | OFF in Auto and timed watering |
| Auto | Start below 35%; stop at 45%; retain state within that band |
| Water now | ON for the remaining server-issued lease, subject to interlocks |
| Stop | OFF until another command |
| Remote lease expires | OFF; a new command is needed |
| No successful server response for 15 seconds during remote watering | OFF; the same command cannot restart it |
| Five-minute continuous runtime reached | OFF; latched until a new command, or in Auto until soil reaches the stop threshold |

The backend accepts 5–300 second timed commands, refuses new starts when the controller is offline, and binds a timed command to the reported boot ID. Receiving the same command never extends its local timer. Rebooting the controller begins with the relay off and cannot resume a command issued to a different boot session.

Auto control can continue locally during a server outage once selected. Stop is a persistent mode, distinct from Auto. When the controller is offline, a server-side Stop remains queued; it is not an immediate physical emergency switch.

These sensor and HTTP libraries use synchronous operations. Control checks run before and after them, not during a blocked call. Connection and response timeouts are set to 2.5 seconds; real stop latency also depends on sensor/WiFi libraries and must be measured on the rig.

## HTTP telemetry and acknowledgment

The controller posts to **`/telemetry`** approximately every two seconds plus processing time, with `Authorization: Bearer <device-key>`. It uses `WiFiSSLClient` for HTTPS or `WiFiClient` for local HTTP.

| Field | Meaning |
| --- | --- |
| `device_id`, `boot_id`, `sequence`, `uptime_ms` | Controller identity, session and packet order |
| `moisture` | Relative moisture percentage |
| `soil_temperature` | DS18B20 °C, or null if invalid/disconnected |
| `air_temperature`, `humidity`, `pressure` | BME280 °C / % RH / hPa, or null when unavailable |
| `nitrogen`, `phosphorus`, `potassium` | Confirmed probe values, otherwise null |
| `ph` | Null until a working physical pH integration is added |
| `rain_detected` | Rain input state |
| `irrigation_active` | Actual commanded relay output; not measured water flow |
| `control_mode`, `control_reason` | Applied control mode and active interlock/reason |
| `applied_command_id` | Last command accepted by the controller |
| `sensor_errors` | Sensor/protocol availability notes |

Each successful response carries `command_id`, `mode`, `remaining_seconds` and related command metadata. The controller applies it locally; the next telemetry packet acknowledges it and reports relay state. The server timestamps samples and marks them stale after its configured freshness window.

See the [FastAPI HTTP contract](../backend/README.md#http-contract) for request examples, endpoint roles, hosting and dashboard configuration. Crop inference remains in the separate ML service; it does not run on this Arduino.
