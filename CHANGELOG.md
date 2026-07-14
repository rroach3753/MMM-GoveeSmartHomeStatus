# Changelog

## [Unreleased]

### Security

- Added instance-scoped socket payload routing (`instanceId`) between frontend and node helper to reduce cross-instance data mixing.
- Added response-size guards (1 MB cap) for cloud API handlers to prevent unbounded memory growth on malformed/oversized responses.

### Changed

- Added `lint` npm script in `package.json` for consistent static checks across module updates.

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
