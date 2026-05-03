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
      hostname: "api.govee.com",
      port: 443,
      path: "/v1/devices",
      method: "GET",
      headers: {
        "Govee-Token": apiKey,
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
      self.sendSocketNotification("GOVEE_DEVICES_ERROR", {
        error: "Request error: " + err.message
      });
    });

    req.end();
  },

  processGoveeResponse: function (data) {
    var devices = [];

    if (data.data && Array.isArray(data.data.devices)) {
      devices = data.data.devices.map(function (device) {
        return {
          deviceId: device.device,
          deviceName: device.deviceName,
          deviceType: device.deviceType,
          model: device.sku || device.model,
          roomName: device.roomName || device.room || "",
          online: device.online,
          powerState: this.getPropertyValue(device.properties, "powerSwitch"),
          temperature: this.getPropertyValue(device.properties, "temperature"),
          humidity: this.getPropertyValue(device.properties, "humidity"),
          brightness: this.getPropertyValue(device.properties, "brightness"),
          colorTemperature: this.getPropertyValue(device.properties, "colorTemperature"),
          color: this.getPropertyValue(device.properties, "color")
        };
      }.bind(this));
    }

    return devices;
  },

  getPropertyValue: function (properties, propertyName) {
    if (!properties || !Array.isArray(properties)) {
      return undefined;
    }

    var prop = properties.find(function (p) {
      return p.type === propertyName;
    });

    return prop ? prop.value : undefined;
  }
});
