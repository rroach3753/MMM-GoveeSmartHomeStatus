const NodeHelper = require("node_helper");
const https = require("node:https");
const dgram = require("node:dgram");

const LAN_DISCOVERY_COMMANDS = ["scan", "scanreport", "devstatus"];
const LAN_DISCOVERY_GROUP = "239.255.255.250";
const LAN_DISCOVERY_SEND_PORT = 4001;
const LAN_DISCOVERY_LISTEN_PORT = 4002;
const LAN_DISCOVERY_MAX_UNICAST_TARGETS = 512;

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
    var lanDiscoveryTargets = this.normalizeDiscoveryTargets(requestOptions.lanDiscoveryTargets);
    var staticLanDevices = this.normalizeStaticLanDevices(requestOptions.lanStaticDevices);

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
      this.discoverLanDevices(lanDiscoveryTimeout, lanDiscoveryTargets, function (lanError, lanDevices) {
        var combinedLanDevices = self.addStaticLanDevices(lanDevices, staticLanDevices);

        if (lanOnly) {
          if (lanError && !combinedLanDevices.length) {
            self.sendDevicesError("LAN discovery failed: " + lanError.message);
            return;
          }

          self.sendDevicesData(combinedLanDevices);
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

          // If LAN discovery fails and there is no static fallback, keep cloud behavior unchanged.
          if (lanError && !combinedLanDevices.length) {
            self.sendDevicesData(cloudDevices);
            return;
          }

          self.sendDevicesData(self.mergeLanIntoCloud(cloudDevices, combinedLanDevices));
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

  discoverLanDevices: function (timeoutMs, targetIps, callback) {
    var socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    var discovered = [];
    var deviceMap = {};
    var isDone = false;
    var self = this;
    var normalizedTargets = this.normalizeDiscoveryTargets(targetIps);

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

      // Optional unicast targets for cross-subnet environments.
      normalizedTargets.forEach(function (targetIp) {
        socket.send(payload, 0, payload.length, LAN_DISCOVERY_SEND_PORT, targetIp);
      });
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

  normalizeDiscoveryTargets: function (targets) {
    var rawList = [];
    var expanded = [];
    var dedupe = {};
    var isTruncated = false;
    var self = this;

    if (Array.isArray(targets)) {
      rawList = targets;
    } else if (typeof targets === "string") {
      rawList = [targets];
    }

    rawList.forEach(function (entry) {
      String(entry || "").split(",").forEach(function (part) {
        var value = String(part || "").trim();

        if (!value) {
          return;
        }

        self.expandDiscoveryTargetEntry(value).forEach(function (ip) {
          if (expanded.length >= LAN_DISCOVERY_MAX_UNICAST_TARGETS) {
            isTruncated = true;
            return;
          }

          if (dedupe[ip]) {
            return;
          }

          dedupe[ip] = true;
          expanded.push(ip);
        });
      });
    });

    if (isTruncated) {
      console.warn("[MMM-GoveeSmartHomeStatus] lanDiscoveryTargets exceeded max of " + LAN_DISCOVERY_MAX_UNICAST_TARGETS + " expanded IPs. Extra entries were ignored.");
    }

    return expanded;
  },

  expandDiscoveryTargetEntry: function (entry) {
    if (entry.indexOf("/") > -1) {
      return this.expandCidrRange(entry);
    }

    return this.isValidIpv4(entry) ? [entry] : [];
  },

  expandCidrRange: function (cidr) {
    var parts = String(cidr || "").split("/");
    var baseIp;
    var prefix;
    var hostCount;
    var networkInt;
    var broadcastInt;
    var start;
    var end;
    var ipList = [];
    var current;

    if (parts.length !== 2) {
      return [];
    }

    baseIp = String(parts[0] || "").trim();
    prefix = Number(parts[1]);

    if (!this.isValidIpv4(baseIp) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
      return [];
    }

    hostCount = Math.pow(2, 32 - prefix);
    networkInt = Math.floor(this.ipv4ToInt(baseIp) / hostCount) * hostCount;
    broadcastInt = networkInt + hostCount - 1;
    start = networkInt;
    end = broadcastInt;

    // For normal LAN ranges, skip network and broadcast addresses.
    if (prefix <= 30) {
      start = networkInt + 1;
      end = broadcastInt - 1;
    }

    for (current = start; current <= end; current += 1) {
      if (ipList.length >= LAN_DISCOVERY_MAX_UNICAST_TARGETS) {
        break;
      }

      ipList.push(this.intToIpv4(current));
    }

    return ipList;
  },

  isValidIpv4: function (value) {
    var parts = String(value || "").trim().split(".");

    if (parts.length !== 4) {
      return false;
    }

    return parts.every(function (part) {
      var num;

      if (part === "" || /[^0-9]/.test(part)) {
        return false;
      }

      num = Number(part);
      return Number.isInteger(num) && num >= 0 && num <= 255;
    });
  },

  ipv4ToInt: function (ipAddress) {
    var parts = String(ipAddress || "").split(".");

    return parts.reduce(function (acc, part) {
      return (acc * 256) + Number(part);
    }, 0);
  },

  intToIpv4: function (numericIp) {
    var value = Number(numericIp);
    var octet1 = Math.floor(value / 16777216) % 256;
    var octet2 = Math.floor(value / 65536) % 256;
    var octet3 = Math.floor(value / 256) % 256;
    var octet4 = value % 256;

    return [octet1, octet2, octet3, octet4].join(".");
  },

  normalizeStaticLanDevices: function (devices) {
    var self = this;

    if (!Array.isArray(devices)) {
      return [];
    }

    return devices.map(function (item) {
      return self.normalizeStaticLanDevice(item);
    }).filter(function (item) {
      return item !== null;
    });
  },

  normalizeStaticLanDevice: function (raw) {
    var staticDevice = raw;
    var deviceId;
    var ip;
    var model;
    var name;

    if (typeof raw === "string") {
      staticDevice = { ip: raw };
    }

    if (!staticDevice || typeof staticDevice !== "object") {
      return null;
    }

    ip = String(staticDevice.ip || staticDevice.localIp || "").trim();
    deviceId = String(staticDevice.deviceId || staticDevice.device || ip || "").trim();
    model = String(staticDevice.model || staticDevice.sku || "").trim();
    name = String(staticDevice.deviceName || staticDevice.name || "").trim();

    if (!deviceId && !ip) {
      return null;
    }

    if (ip && !this.isValidIpv4(ip)) {
      return null;
    }

    return {
      deviceId: deviceId || ip,
      deviceName: name || (model ? (model + " (Static LAN)") : "Govee LAN Device"),
      deviceType: "LAN",
      model: model || "Unknown",
      roomName: String(staticDevice.roomName || ""),
      online: staticDevice.online !== false,
      powerState: undefined,
      temperature: undefined,
      humidity: undefined,
      brightness: undefined,
      colorTemperature: undefined,
      color: undefined,
      localIp: ip || undefined,
      source: "lan-static"
    };
  },

  addStaticLanDevices: function (discovered, staticDevices) {
    var merged = [];
    var dedupe = {};

    function pushIfNew(device) {
      var key = (String(device.deviceId || "") + "::" + String(device.localIp || "")).toLowerCase();

      if (dedupe[key]) {
        return;
      }

      dedupe[key] = true;
      merged.push(device);
    }

    (Array.isArray(discovered) ? discovered : []).forEach(pushIfNew);
    (Array.isArray(staticDevices) ? staticDevices : []).forEach(pushIfNew);

    return merged;
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
