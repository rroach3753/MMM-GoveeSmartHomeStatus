# Changelog

## [Unreleased]

### Changed

- Simplified the README quick-start configuration to the minimum required settings
- Updated ESLint to 10.8.1

### Fixed

- Restored Outlet Pro power draw when Homebridge reports wattage with a service name, lowercase characteristic UUID, or numeric string value
- Reported Homebridge accessory API errors instead of silently treating insecure-mode failures as an empty wattage result

### Security

- Updated the `brace-expansion` override to 5.0.9 to address a denial-of-service vulnerability

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
