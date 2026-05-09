const NodeHelper = require("node_helper");
const https = require("node:https");
const dgram = require("node:dgram");

const LAN_DISCOVERY_COMMANDS = ["scan", "scanreport", "devstatus"];
const LAN_DISCOVERY_GROUP = "239.255.255.250";
const LAN_DISCOVERY_SEND_PORT = 4001;
const LAN_DISCOVERY_LISTEN_PORT = 4002;

module.exports = NodeHelper.create({
  start: function () {
    console.log("MMM-GoveeSmartHomeStatus node_helper started");
  },

  sendDevicesData: function (devices) {
    this.sendSocketNotification("GOVEE_DEVICES_DATA", {
      devices: Array.isArray(devices) ? devices : []
    });
  },

  sendDevicesError: function (errorMessage) {
    this.sendSocketNotification("GOVEE_DEVICES_ERROR", {
      error: String(errorMessage || "Unknown error")
    });
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "GOVEE_DEVICES_REQUEST") {
      this.fetchGoveeDevices(payload || {});
    }
  },

  fetchGoveeDevices: function (requestOptions) {
    var self = this;
    var apiKey = requestOptions.apiKey;
    var enableLanControl = requestOptions.enableLanControl === true;
    var lanOnly = requestOptions.lanOnly === true;
    var lanDiscoveryTimeout = Number(requestOptions.lanDiscoveryTimeout) || 4000;

    function sendCloudData() {
      self.fetchCloudDevices(apiKey, function (error, devices) {
        if (error) {
          self.sendDevicesError(error.message);
          return;
        }

        self.sendDevicesData(devices);
      });
    }

    if (enableLanControl) {
      this.discoverLanDevices(lanDiscoveryTimeout, function (lanError, lanDevices) {
        if (lanOnly) {
          if (lanError) {
            self.sendDevicesError("LAN discovery failed: " + lanError.message);
            return;
          }

          self.sendDevicesData(lanDevices);
          return;
        }

        if (!apiKey) {
          self.sendDevicesError("API key is required unless lanOnly is enabled");
          return;
        }

        self.fetchCloudDevices(apiKey, function (cloudError, cloudDevices) {
          if (cloudError) {
            self.sendDevicesError(cloudError.message);
            return;
          }

          // If LAN discovery fails, keep cloud behavior unchanged.
          if (lanError) {
            self.sendDevicesData(cloudDevices);
            return;
          }

          self.sendDevicesData(self.mergeLanIntoCloud(cloudDevices, lanDevices));
        });
      });

      return;
    }

    if (!apiKey) {
      self.sendDevicesError("API key is required");
      return;
    }

    sendCloudData();
  },

  fetchCloudDevices: function (apiKey, callback) {
    var self = this;
    var isSettled = false;

    function safeCallback(error, devices) {
      if (isSettled) {
        return;
      }

      isSettled = true;
      callback(error, devices);
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
      timeout: 15000
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
            self.fetchDeviceStates(apiKey, devices, function (enrichedDevices) {
              safeCallback(null, enrichedDevices);
            });
          } else if (res.statusCode === 401) {
            safeCallback(new Error("Invalid API key (401)"));
          } else {
            safeCallback(new Error("HTTP " + res.statusCode + ": " + res.statusMessage));
          }
        } catch (err) {
          safeCallback(new Error("Error parsing response: " + err.message));
        }
      });
    });

    req.on("timeout", function () {
      req.destroy();
      safeCallback(new Error("Request timeout"));
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

      safeCallback(new Error(errorMessage));
    });

    req.end();
  },

  discoverLanDevices: function (timeoutMs, callback) {
    var socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    var discovered = [];
    var deviceMap = {};
    var isDone = false;
    var self = this;

    function finish(error) {
      if (isDone) {
        return;
      }

      isDone = true;

      try {
        socket.close();
      } catch (closeError) {
        // noop
      }

      callback(error || null, discovered);
    }

    socket.on("error", function (error) {
      finish(error);
    });

    socket.on("message", function (message, rinfo) {
      var parsed;
      var lanDevice;
      var uniqueKey;

      try {
        parsed = JSON.parse(message.toString("utf8"));
      } catch (parseError) {
        return;
      }

      lanDevice = self.normalizeLanDevice(parsed, rinfo);
      if (!lanDevice) {
        return;
      }

      uniqueKey = (lanDevice.deviceId || "") + "::" + (lanDevice.localIp || "");
      if (deviceMap[uniqueKey]) {
        return;
      }

      deviceMap[uniqueKey] = true;
      discovered.push(lanDevice);
    });

    socket.bind(LAN_DISCOVERY_LISTEN_PORT, function () {
      var payload = Buffer.from(JSON.stringify({
        msg: {
          cmd: "scan",
          data: {
            account_topic: "reserve"
          }
        }
      }));

      socket.setMulticastTTL(2);
      socket.setBroadcast(true);

      try {
        socket.addMembership(LAN_DISCOVERY_GROUP);
      } catch (membershipError) {
        // Membership may fail on some interfaces but multicast send can still work.
      }

      // Multicast + broadcast targets used by Govee LAN implementations.
      socket.send(payload, 0, payload.length, LAN_DISCOVERY_SEND_PORT, LAN_DISCOVERY_GROUP);
      socket.send(payload, 0, payload.length, LAN_DISCOVERY_SEND_PORT, "255.255.255.255");
    });

    setTimeout(function () {
      finish(null);
    }, Math.max(1000, timeoutMs || 4000));
  },

  normalizeLanDevice: function (lanPayload, rinfo) {
    var msg = lanPayload && lanPayload.msg ? lanPayload.msg : {};
    var data = msg && msg.data ? msg.data : {};
    var cmd = msg && msg.cmd ? String(msg.cmd).toLowerCase() : "";
    var senderIp = rinfo && rinfo.address ? String(rinfo.address) : "";
    var deviceId = data.device || data.deviceId || lanPayload.device || "";
    var sku = data.sku || lanPayload.sku || "";
    var payloadIp = data.ip || data.localIp || lanPayload.ip || "";
    var ip = payloadIp || senderIp;
    var name = data.deviceName || data.name || lanPayload.deviceName || "";

    // Accept only known LAN status/discovery packet shapes.
    if (cmd && LAN_DISCOVERY_COMMANDS.indexOf(cmd) === -1) {
      return null;
    }

    // Ignore packets missing all useful identity fields.
    if (!ip && !deviceId) {
      return null;
    }

    // If payload claims a different IP than sender, treat as untrusted.
    if (payloadIp && senderIp && String(payloadIp) !== String(senderIp)) {
      return null;
    }

    return {
      deviceId: deviceId || ip,
      deviceName: name || (sku ? (sku + " (LAN)") : "Govee LAN Device"),
      deviceType: "LAN",
      model: sku || "Unknown",
      roomName: "",
      online: true,
      powerState: undefined,
      temperature: undefined,
      humidity: undefined,
      brightness: undefined,
      colorTemperature: undefined,
      color: undefined,
      localIp: ip || undefined,
      source: "lan"
    };
  },

  mergeLanIntoCloud: function (cloudDevices, lanDevices) {
    var lanById = {};
    var merged = [];

    lanDevices.forEach(function (lanDevice) {
      if (lanDevice.deviceId) {
        lanById[String(lanDevice.deviceId).toLowerCase()] = lanDevice;
      }
    });

    merged = cloudDevices.map(function (cloudDevice) {
      var key = String(cloudDevice.deviceId || "").toLowerCase();
      var lanMatch = lanById[key];

      if (!lanMatch) {
        return cloudDevice;
      }

      return Object.assign({}, cloudDevice, {
        online: true,
        localIp: lanMatch.localIp,
        source: "cloud+lan"
      });
    });

    // Include LAN-only discovered devices that were not present in cloud list.
    lanDevices.forEach(function (lanDevice) {
      var existsInCloud = merged.some(function (device) {
        return String(device.deviceId || "").toLowerCase() === String(lanDevice.deviceId || "").toLowerCase();
      });

      if (!existsInCloud) {
        merged.push(lanDevice);
      }
    });

    return merged;
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
          online: device.online !== false,
          powerState: undefined,
          temperature: undefined,
          humidity: undefined,
          brightness: undefined,
          colorTemperature: undefined,
          color: undefined
        };
      });
    }

    return devices;
  },

  fetchDeviceStates: function (apiKey, devices, callback) {
    var self = this;
    var concurrency = 4;
    var nextIndex = 0;
    var activeCount = 0;
    var completedCount = 0;
    var enrichedDevices = new Array(devices.length);

    if (!devices.length) {
      callback([]);
      return;
    }

    function scheduleNext() {
      while (activeCount < concurrency && nextIndex < devices.length) {
        (function (deviceIndex) {
          activeCount += 1;
          self.fetchDeviceState(apiKey, devices[deviceIndex], function (error, statePayload) {
            if (error) {
              console.error("[MMM-GoveeSmartHomeStatus] State fetch failed for", devices[deviceIndex].deviceName || devices[deviceIndex].deviceId, error.message);
            }

            enrichedDevices[deviceIndex] = self.mergeDeviceState(devices[deviceIndex], statePayload);
            activeCount -= 1;
            completedCount += 1;

            if (completedCount === devices.length) {
              callback(enrichedDevices);
              return;
            }

            scheduleNext();
          });
        }(nextIndex));

        nextIndex += 1;
      }
    }

    scheduleNext();
  },

  fetchDeviceState: function (apiKey, device, callback) {
    var isSettled = false;

    function safeCallback(error, payload) {
      if (isSettled) {
        return;
      }

      isSettled = true;
      callback(error, payload);
    }

    var requestBody = JSON.stringify({
      requestId: this.generateRequestId(),
      payload: {
        sku: device.model,
        device: device.deviceId
      }
    });

    var options = {
      hostname: "openapi.api.govee.com",
      port: 443,
      path: "/router/api/v1/device/state",
      method: "POST",
      headers: {
        "Govee-API-Key": apiKey,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(requestBody)
      },
      timeout: 15000
    };

    var req = https.request(options, function (res) {
      var data = "";

      res.on("data", function (chunk) {
        data += chunk;
      });

      res.on("end", function () {
        var jsonData;

        if (res.statusCode !== 200) {
          safeCallback(new Error("HTTP " + res.statusCode + ": " + res.statusMessage));
          return;
        }

        try {
          jsonData = JSON.parse(data);
        } catch (error) {
          safeCallback(error);
          return;
        }

        if (jsonData.code !== 200 || !jsonData.payload) {
          safeCallback(new Error(jsonData.msg || "Unexpected state response"));
          return;
        }

        safeCallback(null, jsonData.payload);
      });
    });

    req.on("timeout", function () {
      req.destroy(new Error("Request timeout"));
    });

    req.on("error", function (error) {
      safeCallback(error);
    });

    req.write(requestBody);
    req.end();
  },

  mergeDeviceState: function (device, statePayload) {
    var capabilities = statePayload && Array.isArray(statePayload.capabilities)
      ? statePayload.capabilities
      : [];

    return {
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      deviceType: device.deviceType,
      model: device.model,
      roomName: device.roomName,
      online: this.normalizeBoolean(this.getCapabilityState(capabilities, ["online"]), device.online),
      powerState: this.normalizeBoolean(this.getCapabilityState(capabilities, ["powerSwitch"]), device.powerState),
      temperature: this.getNumericCapabilityState(capabilities, ["sensorTemperature", "temperature"]),
      humidity: this.getNumericCapabilityState(capabilities, ["sensorHumidity", "humidity"]),
      brightness: this.getNumericCapabilityState(capabilities, ["brightness"]),
      colorTemperature: this.getNumericCapabilityState(capabilities, ["colorTemperatureK"]),
      color: this.getCapabilityState(capabilities, ["colorRgb"])
    };
  },

  getCapabilityState: function (capabilities, instanceNames) {
    var capability;
    var index;

    if (!Array.isArray(capabilities)) {
      return undefined;
    }

    for (index = 0; index < instanceNames.length; index += 1) {
      capability = capabilities.find(function (item) {
        return item.instance === instanceNames[index] && item.state;
      });

      if (capability) {
        return capability.state.value;
      }
    }

    return undefined;
  },

  getNumericCapabilityState: function (capabilities, instanceNames) {
    var value = this.getCapabilityState(capabilities, instanceNames);
    var numericValue;

    if (value === "" || value === null || typeof value === "undefined") {
      return undefined;
    }

    numericValue = typeof value === "number" ? value : Number(value);
    return Number.isNaN(numericValue) ? undefined : numericValue;
  },

  normalizeBoolean: function (value, fallbackValue) {
    if (typeof value === "boolean") {
      return value;
    }

    if (value === 1 || value === "1" || value === "on") {
      return true;
    }

    if (value === 0 || value === "0" || value === "off") {
      return false;
    }

    return fallbackValue;
  },

  generateRequestId: function () {
    return "govee-" + Date.now() + "-" + Math.floor(Math.random() * 1000000);
  }
});
