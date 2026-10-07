# Changelog

## [Unreleased]

### Documentation

- Added a complete basic `config.js` example with API-key and restart instructions

### Changed

- Updated the development dependency tree to use `ansi-regex` 6.4.0 and
  `micromark-factory-space` 2.1.0

## [2.0.0] - 2026-10-04

### Fixed

- Prevented grouped compact cards from extending off-screen without making the full-width bottom bar excessively tall

### Security

- Required HTTPS for Homebridge origins so credentials and bearer tokens cannot be transmitted over plaintext HTTP
- Made `GOVEE_API_KEY`, `HOMEBRIDGE_URL`, `HOMEBRIDGE_USERNAME`, and `HOMEBRIDGE_PASSWORD` server-only environment settings; renderer-supplied secrets are ignored and no longer sent over the module socket
- Moved Homebridge auto-off and presence/display enablement, targets, thresholds, timing, and display output to fail-closed server environment policy; renderer requests can no longer create or retarget privileged monitors

### Changed

- Existing installations must move Govee and Homebridge credentials from `config.js` to the MagicMirror process environment
- Homebridge auto-off now defaults to disabled; installations using either automation must migrate all former `config.js` automation settings to the documented server environment variables

## [1.4.1] - 2026-09-30

### Fixed

- Corrected Homebridge outlet control to use the config-ui-x service `uniqueId` and writable characteristic type required by the current REST API

## [1.4.0] - 2026-09-30

### Added

- Added a default-enabled Homebridge auto-off monitor for `eBike - Pro` that uses independent local polling and turns the outlet off after power remains below 5W for five minutes

### Fixed

- Restored Pro outlet power draw for Homebridge HTTPS installations using self-signed certificates by preserving the pre-1.3 TLS verification default

### Changed

- Updated transitive development dependencies `@eslint/plugin-kit` to 0.7.3 and `fastq` to 1.20.3
- Updated ESLint to 10.10.0

## [1.3.0] - 2026-09-09

### Added

- Added room-grouped compact cards with room headings, on/total counts, shortened local device labels, configurable room order, and room-aware card limiting

### Changed

- Simplified the README quick-start configuration to the minimum required settings
- Updated ESLint to 10.8.1
- Compact card layouts now group devices by room by default and hide the redundant room summary

### Fixed

- Continued retrying with capped backoff after prolonged network outages so device updates recover without restarting MagicMirror
- Restored Outlet Pro power draw when Homebridge reports wattage with a service name, lowercase characteristic UUID, or numeric string value
- Reported Homebridge accessory API errors instead of silently treating insecure-mode failures as an empty wattage result
- Matched Homebridge power readings to Govee devices by stable device ID when their display names differ
- Kept outlet wattage visible in the standard full-width bottom-bar layout
- Added Bonjour fallback discovery when the configured Homebridge hostname cannot resolve

### Security

- Updated the `brace-expansion` override to 5.0.9 to address a denial-of-service vulnerability
- Updated the `smol-toml` override to 1.8.0 to address a development-tool denial-of-service vulnerability
- Enabled Homebridge TLS certificate verification by default with an explicit `homebridgeVerifySSL` compatibility option
- Limited Homebridge authentication and accessory responses to 1 MB
- Added server-only environment variable support for Govee and Homebridge credentials

## [1.2.0] - 2026-07-24

### Added

- Homebridge power consumption integration: optional polling of the Homebridge config-ui-x REST API to display live wattage on outlet device cards
- New config options: `homebridgeUrl`, `homebridgeUsername`, `homebridgePassword`, `showPowerConsumption`
- Watt value rendered on full-list device items and compact cards (yellow `#facc15` text) for any Govee device whose name matches a Homebridge accessory reporting `CurrentConsumption` (Eve UUID `E863F10D`)
- JWT token caching with automatic re-authentication on expiry (~8 h); Homebridge failures are always silent and do not block Govee device display
- `powerConsumption` field preserved across cloud-state cache refresh and LAN/cloud merge paths

## [1.1.0] - 2026-05-08

### Added

- Optional LAN discovery support with hybrid cloud+LAN mode
- LAN-only mode option for local discovery without API key
- LAN source status badges in standard and compact card views (`LAN` / `LAN+`)

### Changed

- Bottom bar compact cards constrained to a maximum of 2 rows with improved width fitting
- Refined compact layout spacing and typography for better readability in bottom bar mode
- Updated documentation for LAN setup, LAN-only behavior, and configuration examples

### Fixed

- Prevented duplicate backend callback completion paths on timeout/error races
- Prevented overlapping frontend poll timers after error scenarios
- Hardened LAN packet validation to reduce acceptance of malformed/untrusted payloads
- Corrected license file format and refreshed README consistency/details

## [1.0.0] - 2026-05-03

### Added

- Initial release of MMM-GoveeSmartHomeStatus
- Display list of Govee smart devices with status
- Online/offline status indicators
- Support for device type, power state, temperature, and humidity
- Configurable refresh interval
- Error handling and retry logic
- Loading and empty states
- Customizable display messages
