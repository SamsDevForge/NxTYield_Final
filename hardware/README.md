# FarmSense AI hardware reference

The FarmSense controller uses an **Arduino UNO R4 WiFi** with a **BME280** for air temperature, humidity and pressure. This guide records the hardware details supplied by the project maintainer and the accompanying reconstructed sketch.

The sketch is a reconstruction, not the recovered event firmware. It has not been compiled or checked against a connected FarmSense rig in this update.

## Hardware and readings

| Component | Interface | Reading or function |
| --- | --- | --- |
| Arduino UNO R4 WiFi | Controller | Reads sensors, drives the LCD and relay |
| SEN0193 | Analog A0 | Relative moisture percentage after calibration |
| DS18B20 | OneWire on D3 | Soil temperature in °C |
| BME280 | I2C, configured at 0x76 | Air temperature in °C, humidity in % RH, pressure in hPa |
| LM393 rain module | Digital D2 | Rain detected / not detected |
| SN-3002-TR-N-N-NPK-N01 | RS485 / MAX485 | Nitrogen, phosphorus and potassium register values |
| 16×2 LCD | I2C, configured at 0x27 | Moisture, soil temperature, rain and pump state |
| Relay / pump | Digital D4 | Irrigation output |

The pH probe was not working in the prototype. pH values used for demonstration were simulated. The supplied controller sketch does not read or emit pH.

## Reference pin map

| UNO R4 WiFi pin | Connection |
| --- | --- |
| A0 | SEN0193 analog output |
| D2 | LM393 rain module digital output |
| D3 | DS18B20 OneWire data |
| D4 | Relay control input |
| D5 | MAX485 DE and /RE direction control |
| D0 / RX | MAX485 RO |
| D1 / TX | MAX485 DI |
| SDA / A4 | BME280 and LCD SDA |
| SCL / A5 | BME280 and LCD SCL |

`Serial` provides the USB monitor output at 115200 baud. `Serial1` is used for the NPK UART at 4800 baud in this reconstruction. Arduino's [UNO R4 WiFi manual](https://docs.arduino.cc/tutorials/uno-r4-wifi/cheat-sheet) distinguishes USB `Serial` from the D0/D1 `Serial1` UART.

Match power, pull-ups and logic levels to the actual breakout modules. The bare BME280 is a low-voltage device; use an appropriate breakout or level shifting with the UNO R4's 5 V interface. See the [Bosch specifications](https://www.bosch-sensortec.com/en/products/environmental-sensors/humidity-sensors-bme280).

## Arduino setup

1. Install the **Arduino UNO R4 Boards** package in Arduino IDE and select **Arduino UNO R4 WiFi**.
2. Install these libraries through Library Manager:
   - Adafruit BME280 Library
   - Adafruit Unified Sensor
   - OneWire
   - DallasTemperature
   - LiquidCrystal_I2C, with `init()` and `backlight()` support
   - ModbusMaster
3. Open [FarmSenseAI/FarmSenseAI.ino](FarmSenseAI/FarmSenseAI.ino).
4. Verify the configuration below against the actual rig before upload. This repository update does not flash hardware.

## Reconstruction settings

| Setting | Sketch value | What to verify |
| --- | --- | --- |
| BME280 I2C address | 0x76 | Actual breakout address; some use 0x77 |
| LCD I2C address | 0x27 | Actual backpack address |
| Soil dry reading | 800 | Measure with the actual sensor and ADC configuration |
| Soil wet reading | 350 | Measure with the actual sensor and ADC configuration |
| Rain detection | LOW means rain | Check the module's digital output polarity |
| Relay polarity | Active LOW | Match the installed relay |
| NPK slave ID | 1 | Probe configuration |
| NPK baud rate | 4800 | Probe configuration |
| NPK starting register | 0x001E, three registers | **Example only**; confirm the probe's register map, scaling, units and serial format |

The moisture percentage is a linear mapping between the configured dry/wet readings, constrained to 0–100. It is not a calibrated volumetric water-content measurement.

## Irrigation behavior

The supplied reconstruction uses:

```text
rain detected                 → pump OFF
no rain and moisture < 35%     → pump ON
no rain and moisture >= 35%    → pump OFF
```

Rain has priority. There is no separate hysteresis band, maximum run-time control, or remote-command handling in this reference sketch.

The loop reads the sensors, applies that rule, refreshes the LCD, writes a serial report, and then waits two seconds. Blocking sensor and Modbus reads add to that interval.

## Validity and integration limits

- If BME280 initialization fails, the sketch reports that error. A downstream gateway must treat environmental measurements as unavailable until the sensor is working.
- An NPK communication failure prints an error and leaves earlier values in memory. A gateway must track freshness instead of treating them as a new successful sample.
- The register values are not assigned a confirmed nutrient unit or scaling factor here; consult the exact probe's documentation.
- The sketch prints human-readable text, not JSON or HTTP requests.
- The board has WiFi capability, but this sketch does not implement WiFi telemetry or a serial-to-API bridge.
- The crop recommendation model is a separate Python/ML service. This sketch does not perform model inference.

### Dashboard field names

The existing web API normalizes fields such as:

| Controller value | Dashboard/API field |
| --- | --- |
| Relative soil moisture | `moisture` |
| DS18B20 temperature | `soil_temperature` |
| BME280 temperature | `air_temperature` |
| BME280 relative humidity | `humidity` |
| BME280 pressure | `pressure` |
| N, P, K | `nitrogen`, `phosphorus`, `potassium` |
| Rain indication | `rain_detected` |
| Actual irrigation state | `irrigation_active` |
| Sample time | `timestamp` |

A future bridge should send valid, current readings, use `null` for unavailable measurements, and keep simulated pH separate from hardware measurements. See [the API normalizer](../server/apiUtils.js) and [frontend API adapter](../src/lib/api.js).

## Provenance

The project maintainer supplied the component list and reconstructed Arduino code. The reconstruction is preserved in the sketch after a provenance comment; its register settings and calibration remain to be verified on hardware.
