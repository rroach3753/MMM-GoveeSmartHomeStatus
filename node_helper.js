const NodeHelper = require("node_helper");
const https = require("node:https");
const dgram = require("node:dgram");

const LAN_DISCOVERY_COMMANDS = ["scan", "scanreport", "devstatus"];
const LAN_DISCOVERY_GROUP = "239.255.255.250";
const LAN_DISCOVERY_SEND_PORT = 4001;
const LAN_DISCOVERY_LISTEN_PORT = 4002;
const LAN_DEVICE_CONTROL_PORT = 4003;
const LAN_DISCOVERY_MAX_UNICAST_TARGETS = 512;

module.exports = NodeHelper.create({
  start: function () {
    console.log("MMM-GoveeSmartHomeStatus node_helper started");
    this.cloudCacheApiKey = "";
    this.cachedCloudDevices = [];
    this.cachedEnrichedCloudDevices = [];
    this.lastCloudListFetchAt = 0;
    this.lastCloudStateFetchAt = 0;
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
    var cloudDeviceListRefreshInterval = this.normalizeRefreshInterval(requestOptions.cloudDeviceListRefreshInterval);
    var cloudDeviceStateRefreshInterval = this.normalizeRefreshInterval(requestOptions.cloudDeviceStateRefreshInterval);

    function sendCloudData() {
      self.fetchCloudDevicesSegmented(apiKey, cloudDeviceListRefreshInterval, cloudDeviceStateRefreshInterval, function (error, devices) {
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

        self.fetchLanDeviceStatuses(combinedLanDevices, lanDiscoveryTimeout, function (lanStatusError, statusLanDevices) {
          var lanDevicesWithStatus = statusLanDevices;

          if (lanOnly) {
            if ((lanError || lanStatusError) && !lanDevicesWithStatus.length) {
              self.sendDevicesError("LAN discovery failed: " + ((lanError || lanStatusError).message || "Unknown error"));
              return;
            }

            self.sendDevicesData(lanDevicesWithStatus);
            return;
          }

          if (!apiKey) {
            self.sendDevicesError("API key is required unless lanOnly is enabled");
            return;
          }

          self.fetchCloudDevicesSegmented(apiKey, cloudDeviceListRefreshInterval, cloudDeviceStateRefreshInterval, function (cloudError, cloudDevices) {
            if (cloudError) {
              self.sendDevicesError(cloudError.message);
              return;
            }

            // If LAN discovery fails and there is no static fallback, keep cloud behavior unchanged.
            if (lanError && !lanDevicesWithStatus.length) {
              self.sendDevicesData(cloudDevices);
              return;
            }

            self.sendDevicesData(self.mergeLanIntoCloud(cloudDevices, lanDevicesWithStatus));
          });
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

  normalizeRefreshInterval: function (value) {
    var parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed < 0) {
      return 0;
    }

    return Math.floor(parsed);
  },

  resetCloudCache: function (apiKey) {
    this.cloudCacheApiKey = String(apiKey || "");
    this.cachedCloudDevices = [];
    this.cachedEnrichedCloudDevices = [];
    this.lastCloudListFetchAt = 0;
    this.lastCloudStateFetchAt = 0;
  },

  ensureCloudCacheForApiKey: function (apiKey) {
    var currentApiKey = String(apiKey || "");

    if (this.cloudCacheApiKey !== currentApiKey) {
      this.resetCloudCache(currentApiKey);
    }
  },

  fetchCloudDevicesSegmented: function (apiKey, listIntervalMs, stateIntervalMs, callback) {
    var self = this;
    var now = Date.now();
    var listInterval = this.normalizeRefreshInterval(listIntervalMs);
    var stateInterval = this.normalizeRefreshInterval(stateIntervalMs);
    var hasCachedList = Array.isArray(this.cachedCloudDevices) && this.cachedCloudDevices.length > 0;
    var hasCachedEnriched = Array.isArray(this.cachedEnrichedCloudDevices) && this.cachedEnrichedCloudDevices.length > 0;
    var shouldFetchList;
    var shouldFetchState;

    function done(error, devices) {
      callback(error || null, Array.isArray(devices) ? devices : []);
    }

    function updateStatesForDevices(baseDevices) {
      self.fetchDeviceStates(apiKey, baseDevices, function (enrichedDevices) {
        self.cachedEnrichedCloudDevices = Array.isArray(enrichedDevices) ? enrichedDevices : [];
        self.lastCloudStateFetchAt = Date.now();
        done(null, self.cachedEnrichedCloudDevices);
      });
    }

    this.ensureCloudCacheForApiKey(apiKey);

    shouldFetchList = !hasCachedList || listInterval === 0 || !this.lastCloudListFetchAt || (now - this.lastCloudListFetchAt >= listInterval);
    shouldFetchState = !hasCachedEnriched || stateInterval === 0 || !this.lastCloudStateFetchAt || (now - this.lastCloudStateFetchAt >= stateInterval);

    if (shouldFetchList) {
      this.fetchCloudDeviceList(apiKey, function (listError, cloudDevices) {
        if (listError) {
          done(listError);
          return;
        }

        self.cachedCloudDevices = Array.isArray(cloudDevices) ? cloudDevices : [];
        self.lastCloudListFetchAt = Date.now();

        if (shouldFetchState) {
          updateStatesForDevices(self.cachedCloudDevices);
          return;
        }

        done(null, self.applyCachedStateToCloudDevices(self.cachedCloudDevices));
      });

      return;
    }

    if (shouldFetchState) {
      updateStatesForDevices(this.cachedCloudDevices);
      return;
    }

    done(null, this.cachedEnrichedCloudDevices);
  },

  fetchCloudDeviceList: function (apiKey, callback) {
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
            safeCallback(null, self.processGoveeResponse(jsonData));
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

  applyCachedStateToCloudDevices: function (cloudDevices) {
    var stateById = {};

    if (!Array.isArray(cloudDevices)) {
      return [];
    }

    (Array.isArray(this.cachedEnrichedCloudDevices) ? this.cachedEnrichedCloudDevices : []).forEach(function (device) {
      var key = String(device.deviceId || "").toLowerCase();
      if (!key) {
        return;
      }

      stateById[key] = device;
    });

    return cloudDevices.map(function (device) {
      var key = String(device.deviceId || "").toLowerCase();
      var cachedState = stateById[key];

      if (!cachedState) {
        return device;
      }

      return Object.assign({}, device, {
        online: cachedState.online,
        powerState: cachedState.powerState,
        temperature: cachedState.temperature,
        humidity: cachedState.humidity,
        brightness: cachedState.brightness,
        colorTemperature: cachedState.colorTemperature,
        color: cachedState.color
      });
    });
  },

  fetchCloudDevices: function (apiKey, callback) {
    var self = this;

    this.fetchCloudDeviceList(apiKey, function (error, devices) {
      if (error) {
        callback(error);
        return;
      }

      self.fetchDeviceStates(apiKey, devices, function (enrichedDevices) {
        callback(null, enrichedDevices);
      });
    });
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
      try {
        socket.addMembership(LAN_DISCOVERY_GROUP);
      } catch (membershipError) {
        // Membership may fail on some interfaces but multicast send can still work.
      }

      // Multicast target used by Govee LAN implementations.
      try {
        socket.send(payload, 0, payload.length, LAN_DISCOVERY_SEND_PORT, LAN_DISCOVERY_GROUP);
      } catch (sendError) {
        // Ignore send failures here and let timeout-based fallback handle it.
      }

      // Optional unicast targets for cross-subnet environments.
      normalizedTargets.forEach(function (targetIp) {
        try {
          socket.send(payload, 0, payload.length, LAN_DISCOVERY_SEND_PORT, targetIp);
        } catch (sendError) {
          // Ignore individual unicast send failures and continue probing.
        }
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
      powerState: this.parseLanPowerState(lanPayload),
      temperature: undefined,
      humidity: undefined,
      brightness: undefined,
      colorTemperature: undefined,
      color: undefined,
      localIp: ip || undefined,
      source: "lan"
    };
  },

  parseLanPowerState: function (lanPayload) {
    var msg = lanPayload && lanPayload.msg ? lanPayload.msg : {};
    var data = msg && msg.data ? msg.data : {};
    var capabilities = Array.isArray(data.capabilities) ? data.capabilities : [];
    var candidate;

    if (typeof data.powerState !== "undefined") {
      candidate = data.powerState;
    } else if (typeof data.onOff !== "undefined") {
      candidate = data.onOff;
    } else if (typeof data.on !== "undefined") {
      candidate = data.on;
    } else if (typeof data.state !== "undefined") {
      candidate = data.state;
    }

    if (typeof candidate !== "undefined") {
      return this.normalizeBoolean(candidate, undefined);
    }

    return this.normalizeBoolean(this.getCapabilityState(capabilities, ["powerSwitch"]), undefined);
  },

  fetchLanDeviceStatuses: function (lanDevices, timeoutMs, callback) {
    var self = this;
    var devices = Array.isArray(lanDevices) ? lanDevices.filter(function (device) {
      return device && device.localIp;
    }) : [];
    var timeout = Math.max(1000, Number(timeoutMs) || 4000);
    var results = new Array(devices.length);
    var resultReceivedMap = {};
    var sharedSocket = null;
    var isFinished = false;

    function finish() {
      if (isFinished) {
        return;
      }

      isFinished = true;

      if (sharedSocket) {
        try {
          sharedSocket.close();
        } catch (closeError) {
          // noop
        }
      }

      callback(null, results.filter(function (device) {
        return device !== null;
      }));
    }

    if (!devices.length) {
      callback(null, Array.isArray(lanDevices) ? lanDevices : []);
      return;
    }

    // Create a single shared listener socket for all device probes
    sharedSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });

    sharedSocket.on("error", function (error) {
      finish();
    });

    sharedSocket.on("message", function (message, rinfo) {
      var parsed;
      var responseData;
      var statusDevice;
      var responseIp;

      try {
        parsed = JSON.parse(message.toString("utf8"));
      } catch (parseError) {
        return;
      }

      statusDevice = self.normalizeLanDevice(parsed, rinfo);
      if (!statusDevice) {
        return;
      }

      responseData = parsed && parsed.msg && parsed.msg.data ? parsed.msg.data : {};
      responseIp = String((rinfo && rinfo.address) || statusDevice.localIp || "").trim();

      // Find the corresponding device in our list by IP and optionally by deviceId
      devices.forEach(function (device, index) {
        if (resultReceivedMap[index]) {
          return; // Already got a result for this index
        }

        var expectedIp = String(device.localIp || "").trim();
        if (expectedIp && responseIp && expectedIp !== responseIp) {
          return; // IP doesn't match
        }

        var expectedDeviceId = String(device.deviceId || "").trim().toLowerCase();
        var responseDeviceIdRaw = String(responseData.device || responseData.deviceId || parsed.device || "").trim();
        var responseDeviceId = responseDeviceIdRaw.toLowerCase();

        // Only enforce ID matching when the response explicitly reports one.
        if (expectedDeviceId && responseDeviceId && expectedDeviceId !== responseDeviceId) {
          return;
        }

        // This is a match for this device
        resultReceivedMap[index] = true;

        // devStatus replies often omit device ID; preserve discovered ID for cloud merge/LAN+ labeling.
        statusDevice.deviceId = responseDeviceIdRaw || device.deviceId || statusDevice.deviceId;

        if (!statusDevice.deviceName) {
          statusDevice.deviceName = device.deviceName;
        }

        if (!statusDevice.localIp) {
          statusDevice.localIp = device.localIp;
        }

        statusDevice.roomName = device.roomName || statusDevice.roomName;
        statusDevice.model = device.model || statusDevice.model;
        statusDevice.deviceType = device.deviceType || statusDevice.deviceType;
        statusDevice.source = device.source || statusDevice.source;

        results[index] = statusDevice;
      });
    });

    sharedSocket.bind(LAN_DISCOVERY_LISTEN_PORT, function () {
      // Send devStatus probe to all devices in parallel
      var requestPayload = Buffer.from(JSON.stringify({
        msg: {
          cmd: "devStatus",
          data: {}
        }
      }));

      devices.forEach(function (device) {
        try {
          sharedSocket.send(requestPayload, 0, requestPayload.length, LAN_DEVICE_CONTROL_PORT, device.localIp);
        } catch (sendError) {
          // Ignore individual send failures and let timeout handling fall back.
        }
      });
    });

    // Set overall timeout for all probes
    setTimeout(function () {
      // Fill in any missing results with original device data (no response received)
      devices.forEach(function (device, index) {
        if (!resultReceivedMap[index] && results[index] === undefined) {
          results[index] = device;
        }
      });

      finish();
    }, timeout);
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
      online: typeof staticDevice.online === "boolean" ? staticDevice.online : false,
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
        powerState: typeof lanMatch.powerState !== "undefined" ? lanMatch.powerState : cloudDevice.powerState,
        temperature: typeof lanMatch.temperature !== "undefined" ? lanMatch.temperature : cloudDevice.temperature,
        humidity: typeof lanMatch.humidity !== "undefined" ? lanMatch.humidity : cloudDevice.humidity,
        brightness: typeof lanMatch.brightness !== "undefined" ? lanMatch.brightness : cloudDevice.brightness,
        colorTemperature: typeof lanMatch.colorTemperature !== "undefined" ? lanMatch.colorTemperature : cloudDevice.colorTemperature,
        color: typeof lanMatch.color !== "undefined" ? lanMatch.color : cloudDevice.color,
        source: "cloud+lan"
      });
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
