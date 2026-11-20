#pragma once
// Copy to arduino_secrets.h. The real file is gitignored. Never publish real keys.
#define SECRET_SSID "CHANGE_ME"
#define SECRET_PASS "CHANGE_ME"
#define FARMSENSE_DEVICE_ID "farmsense-01"
#define FARMSENSE_DEVICE_API_KEY "CHANGE_ME"
// Hostname only, without scheme or path. Use HTTPS for an internet-facing server.
#define FARMSENSE_HOST "your-farmsense-server.example"
#define FARMSENSE_PORT 443
#ifndef FARMSENSE_USE_TLS
#define FARMSENSE_USE_TLS 1
#endif
// LAN development: use your computer's LAN IP, port 8000 and USE_TLS 0.
