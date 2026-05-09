# MMM-GoveeSmartHomeStatus

A MagicMirror module for displaying Govee smart home device status and information.

[![GitHub Tag](https://img.shields.io/github/v/tag/rroach3753/MMM-GoveeSmartHomeStatus?style=flat-square)](https://github.com/rroach3753/MMM-GoveeSmartHomeStatus/tags)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](https://github.com/rroach3753/MMM-GoveeSmartHomeStatus/blob/main/LICENSE)

**Repository:** [github.com/rroach3753/MMM-GoveeSmartHomeStatus](https://github.com/rroach3753/MMM-GoveeSmartHomeStatus)

## Features

- Display list of Govee smart devices with live online and power state
- Display temperature and humidity when the device reports them
- Color-coded online/offline status indicators
- Real-time device list updates
- Configurable refresh interval
- Full-width bottom bar layout option for compact device display
- **Compact multi-column card grid layout** with 3-4 cards per row (ideal for side panels)
- Lights summary showing on/off counts for detected lights
- Room summary showing on/total devices by room
- Customizable light detection keywords
- Appliance hiding with configurable keyword filters (enabled by default)
- Optional LAN Control discovery for local-network device visibility

## Requirements

- MagicMirror² installed and running
- A Govee account with supported devices
- A Govee Open API key (required)
- Outbound HTTPS access to `openapi.api.govee.com`

For LAN Control mode:
- Enable LAN Control for each device in the Govee app
- Keep MagicMirror and Govee devices on the same local network/VLAN
- Allow local UDP multicast/broadcast discovery traffic

**Note:** This module now calls both Govee APIs: the device list endpoint and the per-device state endpoint. With large device counts, lower refresh intervals will consume your daily API quota faster.

## Installation

### Install (Standard / Git)

1. Navigate to your MagicMirror modules directory:
   ```bash
   cd ~/MagicMirror/modules
   ```

2. Clone the repository from [GitHub](https://github.com/rroach3753/MMM-GoveeSmartHomeStatus):
   ```bash
   git clone https://github.com/rroach3753/MMM-GoveeSmartHomeStatus.git
   ```

3. Navigate into the module directory:
   ```bash
   cd MMM-GoveeSmartHomeStatus
   ```

4. Install dependencies:
   ```bash
   npm install
   ```

### Install (MMPM)

1. Install using MMPM:
   ```bash
   mmpm install MMM-GoveeSmartHomeStatus
   ```

2. If your setup requires dependencies to be installed manually, run:
   ```bash
   cd ~/MagicMirror/modules/MMM-GoveeSmartHomeStatus
   npm install
   ```

## Updating

### Update (Standard / Git)

1. Navigate to the module directory:
   ```bash
   cd ~/MagicMirror/modules/MMM-GoveeSmartHomeStatus
   ```

2. Pull the latest changes:
   ```bash
   git pull
   ```

3. Refresh dependencies (recommended after updates):
   ```bash
   npm install
   ```

### Update (MMPM)

```bash
mmpm update MMM-GoveeSmartHomeStatus
```

## Govee API Key (Required)

This module requires a Govee Open API key. Without it, device data cannot be loaded.

If you configure `enableLanControl: true` and `lanOnly: true`, you can run LAN discovery mode without an API key.

### How to apply/get a key
1. Create or sign in to your Govee account at [https://www.govee.com/](https://www.govee.com/).
2. Go to the Govee developer portal at [https://developer.govee.com/](https://developer.govee.com/) and apply for Open API access.
3. After approval, create/generate your API key from your Govee developer settings.
4. Add the key to your MagicMirror module config:

```javascript
config: {
   apiKey: "YOUR_GOVEE_API_KEY"
}
```

### Alternative: get API key in the Govee mobile app
If you prefer, you can request/generate your API key directly in the Govee app:

1. Open the Govee Home app and sign in.
2. Go to **Profile**.
3. Open **About Us**.
4. Tap **Apply for API Key** (or **Request API Key**, depending on app version).
5. Submit the request and copy the generated key once approved/available.
6. Paste that key into your module config (`apiKey: "YOUR_GOVEE_API_KEY"`).

If you do not see the API key option in-app, update the app to the latest version and check the developer portal method above.

## Configuration

Add to your `config.js`:

```javascript
{
  module: "MMM-GoveeSmartHomeStatus",
  position: "top_right",
  config: {
    apiKey: "YOUR_GOVEE_API_KEY",
    title: "Govee Devices",
    refreshInterval: 480000,           // Refresh every 8 minutes (ms)
    showOnlineOnly: false,             // Show all devices or only online
    showPower: true,                   // Display live power state when available
    showTemperature: true,             // Display live temperature when available
    showHumidity: true,                // Display live humidity when available
    showLightsSummary: true,           // Show lights count summary
    showRoomSummary: true,             // Show per-room summary
    roomSummaryLightsOnly: false,      // Include all devices in room summary
    lightDetectionKeywords: ["light", "lamp", "bulb", "strip", "led"],
    hideAppliances: true,              // Hide appliance devices by keyword
    hiddenApplianceKeywords: ["ice maker", "fridge"],
    roomNameDelimiter: " - ",          // Room parsing from device names (e.g. "Kitchen - Lamp")
   enableLanControl: false,
   lanOnly: false,
   lanDiscoveryTimeout: 4000,
    fullWidthBottomBar: false,
    emptyMessage: "No devices available.",
    loadingMessage: "Loading Govee devices...",
    noApiKeyMessage: "API key not configured.",
    errorMessage: "Error fetching Govee device data."
  }
},
```

## Configuration Options

| Option | Type | Description | Default |
|--------|------|-------------|---------|
| `apiKey` | String | Your Govee API key (required) | `""` |
| `title` | String | Module title | `"Govee Devices"` |
| `refreshInterval` | Number | Refresh interval in milliseconds (0 to disable) | `480000` |
| `showOnlineOnly` | Boolean | Show only devices currently reporting online | `false` |
| `showPower` | Boolean | Display live power state when available | `true` |
| `showTemperature` | Boolean | Display live temperature when available | `true` |
| `showHumidity` | Boolean | Display live humidity when available | `true` |
| `showLightsSummary` | Boolean | Show total lights count summary | `true` |
| `showRoomSummary` | Boolean | Show per-room on/total summary | `true` |
| `roomSummaryLightsOnly` | Boolean | Limit room summary counts to light devices | `false` |
| `lightDetectionKeywords` | Array | Case-insensitive keywords used to classify devices as lights | `['light', 'lamp', 'bulb', 'strip', 'led']` |
| `hideAppliances` | Boolean | Hide appliance-like devices from display | `true` |
| `hiddenApplianceKeywords` | Array | Case-insensitive keywords used to hide appliances | `['ice maker', 'icemaker', 'refrigerator', 'fridge']` |
| `roomNameDelimiter` | String | Delimiter used to infer room from device name | `' - '` |
| `enableLanControl` | Boolean | Enable LAN discovery in addition to cloud API | `false` |
| `lanOnly` | Boolean | Use LAN discovery only (no API key required) | `false` |
| `lanDiscoveryTimeout` | Number | LAN discovery timeout in milliseconds | `4000` |
| `compactCards` | Boolean | Display devices as compact horizontal cards (scrollable) | `false` |
| `maxCompactCards` | Number | Maximum number of devices to show in compact card view | `12` |
| `emptyMessage` | String | Message when no devices available | `"No devices available."` |
| `loadingMessage` | String | Loading message | `"Loading Govee devices..."` |
| `noApiKeyMessage` | String | Message when API key not configured | `"API key not configured."` |
| `errorMessage` | String | Error message | `"Error fetching Govee device data."` |
| `fullWidthBottomBar` | Boolean | Span full width of bottom_bar position | `false` |

## Usage Examples

### Standard Layout (Top Right Position)
```javascript
{
   module: "MMM-GoveeSmartHomeStatus",
   position: "top_right",
   config: {
      apiKey: "YOUR_GOVEE_API_KEY",
      title: "Govee Devices"
   }
},
```

### Full-Width Bottom Bar Layout
```javascript
{
   module: "MMM-GoveeSmartHomeStatus",
   position: "bottom_bar",
   config: {
      apiKey: "YOUR_GOVEE_API_KEY",
      fullWidthBottomBar: true,
      showTemperature: false,
      showHumidity: false
   }
},
```

### Disable Summaries and Show Appliances
```javascript
{
   module: "MMM-GoveeSmartHomeStatus",
   position: "top_right",
   config: {
      apiKey: "YOUR_GOVEE_API_KEY",
      showLightsSummary: false,
      showRoomSummary: false,
      hideAppliances: false
   }
},
```

### Hybrid Cloud + LAN Discovery (Recommended)
```javascript
{
   module: "MMM-GoveeSmartHomeStatus",
   position: "top_right",
   config: {
      apiKey: "YOUR_GOVEE_API_KEY",
      enableLanControl: true,
      lanOnly: false,
      lanDiscoveryTimeout: 4000
   }
},
```

### LAN-Only Discovery (No API Key)
```javascript
{
   module: "MMM-GoveeSmartHomeStatus",
   position: "top_right",
   config: {
      enableLanControl: true,
      lanOnly: true,
      lanDiscoveryTimeout: 5000
   }
},
```

### Compact Cards Layout with Room Summaries
```javascript
{
   module: "MMM-GoveeSmartHomeStatus",
   position: "bottom_right",
   config: {
      apiKey: "YOUR_GOVEE_API_KEY",
      compactCards: true,
      maxCompactCards: 12,
      showRoomSummary: true,
      showLightsSummary: true
   }
},
```

## Screenshots

### Bottom Bar Layout

![Bottom bar layout preview](images/in_bottom_bar.png)

In this layout:
- Summaries are centered horizontally above device cards
- Lights and room summaries render in a horizontal row
- Device cards are compact and fit into a maximum of 2 rows

### Side Panel Layout (Bottom Right)

![Outside bottom_bar layout preview](images/outside_bottom_bar.png)

This layout displays:
- **Lights Summary** — Total count of lights on/off (e.g., "7 on / 16 off")
- **Room Summary** — 2-column grid showing per-room device counts with color-coding:
  - Green border/text for rooms with at least one device ON
  - Gray border/text for rooms with all devices OFF
- **Device Grid** — Compact 3-column card layout showing all devices with name and power state (ON/OFF)
  - Green border indicates powered ON devices
  - Gray border indicates powered OFF devices
  - Perfect for side panels (bottom_right, top_right, etc.)

## Customizing Light Detection

The module classifies a device as a light when its name, type, or model contains a keyword from `lightDetectionKeywords`. This is used for the lights summary and for detecting light devices in room summaries.

### Example: Add custom light keywords
```javascript
{
   module: "MMM-GoveeSmartHomeStatus",
   position: "top_right",
   config: {
      apiKey: "YOUR_GOVEE_API_KEY",
      lightDetectionKeywords: ["light", "lamp", "bulb", "strip", "led", "sconce", "can", "uplight"]
   }
},
```

### Example: Strict light matching (only certain types)
```javascript
{
   module: "MMM-GoveeSmartHomeStatus",
   position: "top_right",
   config: {
      apiKey: "YOUR_GOVEE_API_KEY",
      lightDetectionKeywords: ["bulb", "strip"]
   }
},
```

## Troubleshooting

### DNS Resolution Error: "getaddrinfo ENOTFOUND api.govee.com"

This error indicates your system cannot reach the Govee API server. Try these steps:

1. **Check Network Connectivity**
   ```bash
   ping -c 4 openapi.api.govee.com
   nslookup openapi.api.govee.com
   ```

2. **Check Firewall/Network Access**
   - Ensure your network allows HTTPS (port 443) outbound connections
   - Check if your ISP or network is blocking access to openapi.api.govee.com
   - Try disabling VPN or proxy if you're using one

3. **Verify DNS Configuration**
   ```bash
   cat /etc/resolv.conf
   ```
   Ensure you have valid DNS servers configured (e.g., 8.8.8.8, 1.1.1.1)

4. **Test API Connectivity**
   ```bash
   curl -H "Govee-API-Key: YOUR_API_KEY" https://openapi.api.govee.com/router/api/v1/user/devices
   ```

### Invalid API Key Error

- Verify your API key is correct in config.js
- Check that there are no extra spaces or quotes around the key
- Regenerate your API key from the Govee app if unsure

### No Devices Displayed

- Verify you have Govee devices added to your account
- Ensure the devices are online and connected to WiFi
- Check that your API key has permissions to access device data
- If `hideAppliances` is enabled, appliance-like names such as `ice maker` or `fridge` may be filtered out intentionally

### API Usage Notes

- The module calls the device list endpoint once per refresh plus one state request per returned device
- Example: 25 devices with an 8 minute refresh interval is about 4,680 requests per day
- Govee documents a 10,000 request per account per day limit, so avoid very short refresh intervals on larger device lists

## Dependencies

None - uses Node.js built-in modules (`https`, `url`)

## License

MIT

## Support & Contribution

For issues, feature requests, or contributions, please visit the [GitHub repository](https://github.com/rroach3753/MMM-GoveeSmartHomeStatus).

- [Issues](https://github.com/rroach3753/MMM-GoveeSmartHomeStatus/issues)
- [Discussions](https://github.com/rroach3753/MMM-GoveeSmartHomeStatus/discussions)
- [Pull Requests](https://github.com/rroach3753/MMM-GoveeSmartHomeStatus/pulls)
