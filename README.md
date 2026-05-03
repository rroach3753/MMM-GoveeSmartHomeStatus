# MMM-GoveeSmartHomeStatus

A MagicMirror module for displaying Govee smart home device status and information.

[![GitHub Release](https://img.shields.io/github/v/release/rroach3753/MMM-GoveeSmartHomeStatus?style=flat-square)](https://github.com/rroach3753/MMM-GoveeSmartHomeStatus)
[![GitHub License](https://img.shields.io/github/license/rroach3753/MMM-GoveeSmartHomeStatus?style=flat-square)](https://github.com/rroach3753/MMM-GoveeSmartHomeStatus/blob/main/LICENSE)

**Repository:** [github.com/rroach3753/MMM-GoveeSmartHomeStatus](https://github.com/rroach3753/MMM-GoveeSmartHomeStatus)

## Features

- Display list of Govee smart devices with online/offline status
- Show device type (lights, smart plugs, thermostats, etc.)
- Display power state, temperature, and humidity when available
- Real-time device status updates
- Configurable refresh interval
- Color-coded status indicators
- Full-width bottom bar layout option for compact device display
- Lights summary showing all lights on/off
- Room summary showing on/total devices by room (lights-only by default)
- Configurable light detection keywords so you can define what counts as a light
- Appliance hiding with configurable keyword filters (enabled by default)

## Installation

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

## Configuration

Add to your `config.js`:

```javascript
{
  module: "MMM-GoveeSmartHomeStatus",
  position: "top_right",
  config: {
    apiKey: "YOUR_GOVEE_API_KEY",
    title: "Govee Devices",
    refreshInterval: 300000,        // Refresh every 5 minutes (ms)
    showOnlineOnly: false,          // Show all devices or only online
    showDeviceType: true,           // Display device type
    showPower: true,                // Show power state
    showTemperature: true,          // Show temperature (if available)
    showHumidity: true,             // Show humidity (if available)
    showLightsSummary: true,        // Show lights on/off summary
    showRoomSummary: true,          // Show per-room summary
    roomSummaryLightsOnly: true,    // Room summary counts only lights
      useCustomLightDetectionKeywords: true,
    lightDetectionKeywords: ["light", "lamp", "bulb", "strip", "led"],
    hideAppliances: true,           // Hide appliance devices by keyword
    hiddenApplianceKeywords: ["ice maker", "fridge"],
    roomNameDelimiter: " - ",      // Room parsing from device names (e.g. "Kitchen - Lamp")
    fullWidthBottomBar: false,
    emptyMessage: "No devices available.",
    loadingMessage: "Loading Govee devices...",
    noApiKeyMessage: "API key not configured.",
    errorMessage: "Error fetching Govee device data."
  }
}
```

## Configuration Options

| Option | Type | Description | Default |
|--------|------|-------------|---------|
| `apiKey` | String | Your Govee API key (required) | `""` |
| `title` | String | Module title | `"Govee Devices"` |
| `refreshInterval` | Number | Refresh interval in milliseconds (0 to disable) | `300000` |
| `showOnlineOnly` | Boolean | Show only online devices | `false` |
| `showDeviceType` | Boolean | Display device type | `true` |
| `showPower` | Boolean | Show power state | `true` |
| `showTemperature` | Boolean | Show temperature (if available) | `true` |
| `showHumidity` | Boolean | Show humidity (if available) | `true` |
| `showLightsSummary` | Boolean | Show total lights on/off summary | `true` |
| `showRoomSummary` | Boolean | Show per-room on/total summary | `true` |
| `roomSummaryLightsOnly` | Boolean | Limit room summary counts to light devices | `true` |
| `useCustomLightDetectionKeywords` | Boolean | Enable use of `lightDetectionKeywords` list | `true` |
| `lightDetectionKeywords` | Array | Case-insensitive keywords used to classify devices as lights | `['light', 'lamp', 'bulb', 'strip', 'led']` |
| `hideAppliances` | Boolean | Hide appliance-like devices from display | `true` |
| `hiddenApplianceKeywords` | Array | Case-insensitive keywords used to hide appliances | `['ice maker', 'icemaker', 'refrigerator', 'fridge']` |
| `roomNameDelimiter` | String | Delimiter used to infer room from device name | `' - '` |
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
}
```

### Full-Width Bottom Bar Layout
```javascript
{
   module: "MMM-GoveeSmartHomeStatus",
   position: "bottom_bar",
   config: {
      apiKey: "YOUR_GOVEE_API_KEY",
         fullWidthBottomBar: true,
      showDeviceType: false,      // Reduce clutter in compact view
         showHumidity: false         // Hide less critical info
   }
}
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
}
```

### Room Summary Includes All Devices
```javascript
{
   module: "MMM-GoveeSmartHomeStatus",
   position: "top_right",
   config: {
      apiKey: "YOUR_GOVEE_API_KEY",
         showRoomSummary: true,
         roomSummaryLightsOnly: false
   }
}
```

## How Light Detection Works

The module treats a device as a light when its name, type, or model contains a keyword.

- If `useCustomLightDetectionKeywords: true`, keywords come from `lightDetectionKeywords`.
- If `useCustomLightDetectionKeywords: false`, built-in defaults are used: `['light', 'lamp', 'bulb', 'strip', 'led']`.

Use the custom mode when your devices use labels like "sconce" or "uplight" and you want summaries to include them.

### Example: Add custom light keywords
```javascript
{
   module: "MMM-GoveeSmartHomeStatus",
   position: "top_right",
   config: {
      apiKey: "YOUR_GOVEE_API_KEY",
      useCustomLightDetectionKeywords: true,
         lightDetectionKeywords: ["light", "lamp", "bulb", "strip", "led", "sconce", "can", "uplight"]
   }
}
```

### Example: Very strict light matching
```javascript
{
   module: "MMM-GoveeSmartHomeStatus",
   position: "top_right",
   config: {
      apiKey: "YOUR_GOVEE_API_KEY",
      useCustomLightDetectionKeywords: true,
         lightDetectionKeywords: ["bulb", "strip"]
   }
}
```

### Example: Disable custom list and use built-in defaults
```javascript
{
   module: "MMM-GoveeSmartHomeStatus",
   position: "top_right",
   config: {
      apiKey: "YOUR_GOVEE_API_KEY",
      useCustomLightDetectionKeywords: false
   }
}
```

## Getting Your API Key
1. Visit [https://www.govee.com/](https://www.govee.com/)
2. Log in to your account
3. Navigate to Developer Settings
4. Generate an API key
5. Add it to your module configuration

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

## Dependencies

None - uses Node.js built-in modules (`https`, `url`)

## License

MIT

## Support & Contribution

For issues, feature requests, or contributions, please visit the [GitHub repository](https://github.com/rroach3753/MMM-GoveeSmartHomeStatus).

- [Issues](https://github.com/rroach3753/MMM-GoveeSmartHomeStatus/issues)
- [Discussions](https://github.com/rroach3753/MMM-GoveeSmartHomeStatus/discussions)
- [Pull Requests](https://github.com/rroach3753/MMM-GoveeSmartHomeStatus/pulls)
