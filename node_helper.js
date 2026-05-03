const NodeHelper = require("node_helper");
const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

module.exports = NodeHelper.create({
  start: function () {
    console.log("MMM-GoveeSmartHomeStatus node_helper started");
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "GOVEE_DEVICES_REQUEST") {
      this.fetchGoveeDevices(payload.apiKey);
    }
  },

  fetchGoveeDevices: function (apiKey) {
    var self = this;

    if (!apiKey) {
      self.sendSocketNotification("GOVEE_DEVICES_ERROR", {
        error: "API key is required"
      });
      return;
    }

    var options = {
      hostname: "openapi.api.govee.com",
      port: 443,
      path: "/router/api/v1/user/devices",
      method: "GET",
      headers: {
        "Govee-API-Key": apiKey,
        "Content-Type": "application/json"
      },
      timeout: 10000
    };

    var req = https.request(options, function (res) {
      var data = "";

      res.on("data", function (chunk) {
        data += chunk;
      });

      res.on("end", function () {
        try {
          if (res.statusCode === 200) {
            var jsonData = JSON.parse(data);
            var devices = self.processGoveeResponse(jsonData);
            self.sendSocketNotification("GOVEE_DEVICES_DATA", {
              devices: devices
            });
          } else if (res.statusCode === 401) {
            self.sendSocketNotification("GOVEE_DEVICES_ERROR", {
              error: "Invalid API key (401)"
            });
          } else {
            self.sendSocketNotification("GOVEE_DEVICES_ERROR", {
              error: "HTTP " + res.statusCode + ": " + res.statusMessage
            });
          }
        } catch (err) {
          self.sendSocketNotification("GOVEE_DEVICES_ERROR", {
            error: "Error parsing response: " + err.message
          });
        }
      });
    });

    req.on("timeout", function () {
      req.destroy();
      self.sendSocketNotification("GOVEE_DEVICES_ERROR", {
        error: "Request timeout"
      });
    });

    req.on("error", function (err) {
      console.error("[MMM-GoveeSmartHomeStatus] Request error:", err.message);
      var errorMessage = "Request error: " + err.message;
      
      if (err.code === "ENOTFOUND") {
        errorMessage = "DNS resolution failed for openapi.api.govee.com. Check your network connection and firewall settings.";
      } else if (err.code === "ECONNREFUSED") {
        errorMessage = "Connection refused by openapi.api.govee.com. The API may be temporarily unavailable.";
      } else if (err.code === "ETIMEDOUT" || err.code === "ECONNRESET") {
        errorMessage = "Connection timeout. Check your network connection.";
      }
      
      self.sendSocketNotification("GOVEE_DEVICES_ERROR", {
        error: errorMessage
      });
    });

    req.end();
  },

  processGoveeResponse: function (data) {
    var devices = [];

    if (data.data && Array.isArray(data.data)) {
      devices = data.data.map(function (device) {
        return {
          deviceId: device.device,
          deviceName: device.deviceName,
          deviceType: device.type,
          model: device.sku,
          roomName: device.roomName || device.room || "",
          online: device.online !== false, // Default to online if not specified
          powerState: undefined, // Would need separate API call to get current state
          temperature: undefined,
          humidity: undefined,
          brightness: undefined,
          colorTemperature: undefined,
          color: undefined
        };
      }.bind(this));
    }

    return devices;
  }
});
