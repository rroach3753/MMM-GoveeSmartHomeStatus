const NodeHelper = require("node_helper");
const homebridge = require("./lib/homebridge");
const https = require("node:https");
const dgram = require("node:dgram");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LAN_DISCOVERY_COMMANDS = ["scan", "scanreport", "devstatus"];
const LAN_DISCOVERY_GROUP = "239.255.255.250";
const LAN_DISCOVERY_SEND_PORT = 4001;
const LAN_DISCOVERY_LISTEN_PORT = 4002;
const LAN_DEVICE_CONTROL_PORT = 4003;
const LAN_DISCOVERY_MAX_UNICAST_TARGETS = 512;
const SERVER_AUTO_OFF_MONITOR_ID = "__server_homebridge_auto_off";

module.exports = NodeHelper.create({
  ...homebridge,
  start: function () {
    if (this.pendingCleanups) this.stop();
    this.stopped = false;
    this.pendingCleanups = new Set();
    console.log("MMM-GoveeSmartHomeStatus node_helper started");
    this.cloudCaches = new Map();
    this.rendererFetchState = null;
    this.homebridgeTokenCache = new Map();
    this.homebridgeFallbackUrls = {};
    this.homebridgeAutoOffMonitors = {};
    this.initializeServerAutomations();
  },

  stop: function () {
    this.stopped = true;
    Object.values(this.homebridgeAutoOffMonitors || {}).forEach(function (monitor) {
      clearTimeout(monitor.timer);
    });
    this.homebridgeAutoOffMonitors = {};
    this.rendererFetchState = null;
    for (const cleanup of this.pendingCleanups || []) cleanup();
    this.pendingCleanups = new Set();
    this.cloudCaches = new Map();
    this.homebridgeTokenCache = new Map();
    this.homebridgeFallbackUrls = {};
  },

  trackCleanup: function (cleanup) {
    if (!this.pendingCleanups) this.pendingCleanups = new Set();
    this.pendingCleanups.add(cleanup);
  },

  sendDevicesData: function (devices, instanceId) {
    this.sendSocketNotification("GOVEE_DEVICES_DATA", {
      instanceId: instanceId || null,
      devices: Array.isArray(devices) ? devices : []
    });
  },

  sendDevicesError: function (errorMessage, instanceId) {
    this.sendSocketNotification("GOVEE_DEVICES_ERROR", {
      instanceId: instanceId || null,
      error: String(errorMessage || "Unknown error")
    });
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "GOVEE_DEVICES_REQUEST") {
      this.handleDevicesRequest(payload);
    }
  },

  handleDevicesRequest: function (payload) {
    if (this.stopped) return;
    var self = this;
    var options = payload == null ? {} : payload;
    var instanceId = options.instanceId;
    var intervals = [options.cloudDeviceListRefreshInterval, options.cloudDeviceStateRefreshInterval];
    if (typeof options !== "object" || Array.isArray(options) ||
        (instanceId != null && (typeof instanceId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(instanceId))) ||
        intervals.some(function (value) {
          return value != null && ((typeof value !== "number" && typeof value !== "string") || !Number.isFinite(Number(value)));
        })) {
      this.sendDevicesError("Invalid device request.", typeof instanceId === "string" ? instanceId : null);
      return;
    }

    if (!this.rendererFetchState) {
      this.rendererFetchState = { pending: false, waiters: new Set(), completedAt: null, devices: [], error: null };
    }
    var state = this.rendererFetchState;
    if (state.completedAt !== null && Date.now() - state.completedAt < 30000) {
      if (state.error) this.sendDevicesError(state.error, instanceId);
      else this.sendDevicesData(state.devices, instanceId);
      return;
    }
    if (!state.waiters.has(instanceId) && state.waiters.size >= 32) {
      this.sendDevicesError("Too many pending device requests.", instanceId);
      return;
    }
    state.waiters.add(instanceId);
    if (state.pending) return;
    state.pending = true;
    this.fetchGoveeDevices(options, function (error, devices) {
      if (self.stopped || self.rendererFetchState !== state) return;
      state.pending = false;
      state.completedAt = Date.now();
      state.error = error || null;
      state.devices = devices || [];
      var waiters = Array.from(state.waiters);
      state.waiters.clear();
      waiters.forEach(function (id) {
        if (state.error) self.sendDevicesError(state.error, id);
        else self.sendDevicesData(state.devices, id);
      });
    });
  },

  fetchGoveeDevices: function (requestOptions, callback) {
    var self = this;
    var instanceId = requestOptions.instanceId || null;
    var homebridgeConfig = this.resolveHomebridgeConfig();
    var lanConfig = this.resolveLanConfig();
    var apiKey = String(process.env.GOVEE_API_KEY || "").trim();
    var cloudDeviceListRefreshInterval = this.normalizeRefreshInterval(requestOptions.cloudDeviceListRefreshInterval);
    var cloudDeviceStateRefreshInterval = this.normalizeRefreshInterval(requestOptions.cloudDeviceStateRefreshInterval);
    var homebridgeUrl = homebridgeConfig.url;
    var homebridgeUsername = homebridgeConfig.username;
    var homebridgePassword = homebridgeConfig.password;
    var homebridgeVerifySSL = this.resolveHomebridgeVerifySSL();
    var hasHomebridge = !!(homebridgeUrl && homebridgeUsername);

    function finish(error, devices) {
      if (callback) callback(error, devices);
      else if (error) self.sendDevicesError(error, instanceId);
      else self.sendDevicesData(devices, instanceId);
    }

    if (homebridgeConfig.error) {
      finish(homebridgeConfig.error);
      return;
    }

    if (lanConfig.error) {
      finish(lanConfig.error);
      return;
    }

    function finalSend(devices) {
      if (!hasHomebridge) {
        finish(null, devices);
        return;
      }
      self.withHomebridgePower(homebridgeUrl, homebridgeUsername, homebridgePassword, homebridgeVerifySSL, devices, function (enrichedDevices) {
        finish(null, enrichedDevices);
      }, homebridgeConfig.allowDiscovery);
    }

    function sendCloudData() {
      self.fetchCloudDevicesSegmented(apiKey, cloudDeviceListRefreshInterval, cloudDeviceStateRefreshInterval, function (error, devices) {
        if (error) {
          finish(error.message);
          return;
        }

        finalSend(devices);
      });
    }

    if (lanConfig.enabled) {
      this.discoverLanDevices(lanConfig.timeout, lanConfig.discoveryTargets, function (lanError, lanDevices) {
        var combinedLanDevices = self.addStaticLanDevices(lanDevices, lanConfig.staticDevices);

        self.fetchLanDeviceStatuses(combinedLanDevices, lanConfig.timeout, function (lanStatusError, statusLanDevices) {
          var lanDevicesWithStatus = statusLanDevices;

          if (lanConfig.only) {
            if ((lanError || lanStatusError) && !lanDevicesWithStatus.length) {
              finish("LAN discovery failed: " + ((lanError || lanStatusError).message || "Unknown error"));
              return;
            }

            finalSend(lanDevicesWithStatus);
            return;
          }

          if (!apiKey) {
            finish("API key is required unless GOVEE_LAN_ONLY is enabled");
            return;
          }

          self.fetchCloudDevicesSegmented(apiKey, cloudDeviceListRefreshInterval, cloudDeviceStateRefreshInterval, function (cloudError, cloudDevices) {
            if (cloudError) {
              finish(cloudError.message);
              return;
            }

            // If LAN discovery fails and there is no static fallback, keep cloud behavior unchanged.
            if (lanError && !lanDevicesWithStatus.length) {
              finalSend(cloudDevices);
              return;
            }

            finalSend(self.mergeLanIntoCloud(cloudDevices, lanDevicesWithStatus));
          });
        });
      });

      return;
    }

    if (!apiKey) {
      finish("API key is required");
      return;
    }

    sendCloudData();
  },

  resolveLanConfig: function () {
    var enabledSetting = this.resolveServerAutomationEnabled("GOVEE_LAN_CONTROL_ENABLED");
    var onlySetting = this.resolveServerAutomationEnabled("GOVEE_LAN_ONLY");
    var timeoutValue = String(process.env.GOVEE_LAN_DISCOVERY_TIMEOUT_MS || "").trim();
    var timeout = timeoutValue ? Number(timeoutValue) : 4000;
    var rawStaticDevices = String(process.env.GOVEE_LAN_STATIC_DEVICES || "").trim();
    var staticDevices = [];

    if (enabledSetting.error || onlySetting.error) {
      return {
        error: enabledSetting.error || onlySetting.error
      };
    }

    if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 30000) {
      return {
        error: "GOVEE_LAN_DISCOVERY_TIMEOUT_MS must be between 1000 and 30000."
      };
    }

    if (rawStaticDevices) {
      try {
        staticDevices = JSON.parse(rawStaticDevices);
      } catch {
        return {
          error: "GOVEE_LAN_STATIC_DEVICES must be a valid JSON array."
        };
      }

      if (!Array.isArray(staticDevices)) {
        return {
          error: "GOVEE_LAN_STATIC_DEVICES must be a valid JSON array."
        };
      }
    }

    return {
      enabled: enabledSetting.enabled,
      only: enabledSetting.enabled && onlySetting.enabled,
      timeout: timeout,
      discoveryTargets: this.normalizeDiscoveryTargets(process.env.GOVEE_LAN_DISCOVERY_TARGETS),
      staticDevices: this.normalizeStaticLanDevices(staticDevices),
      error: null
    };
  },

  resolveHomebridgeConfig: function () {
    var serverUsername = String(process.env.HOMEBRIDGE_USERNAME || "").trim();
    var serverPassword = String(process.env.HOMEBRIDGE_PASSWORD || "");
    var serverUrl = String(process.env.HOMEBRIDGE_URL || "").trim();
    var hasServerConfig = !!(serverUrl || serverUsername || serverPassword);
    var canonicalServerUrl;

    try {
      canonicalServerUrl = serverUrl ? this.canonicalizeHomebridgeOrigin(serverUrl) : "";
    } catch {
      return {
        url: "",
        username: "",
        password: "",
        allowDiscovery: false,
        error: "HOMEBRIDGE_URL must be a valid HTTPS origin without a path, query, or credentials."
      };
    }

    if (!hasServerConfig) {
      return {
        url: "",
        username: "",
        password: "",
        allowDiscovery: false,
        error: null
      };
    }

    if (!serverUrl) {
      return {
        url: "",
        username: "",
        password: "",
        allowDiscovery: false,
        error: "HOMEBRIDGE_URL is required when server-side Homebridge credentials are configured."
      };
    }

    if (!serverUsername) {
      return {
        url: "",
        username: "",
        password: "",
        allowDiscovery: false,
        error: "HOMEBRIDGE_USERNAME is required when Homebridge integration is configured."
      };
    }

    return {
      url: canonicalServerUrl,
      username: serverUsername,
      password: serverPassword,
      allowDiscovery: false,
      error: null
    };
  },

  resolveHomebridgeVerifySSL: function () {
    return this.normalizeBoolean(process.env.HOMEBRIDGE_VERIFY_SSL, true);
  },

  resolveServerAutomationEnabled: function (name) {
    var rawValue = String(process.env[name] || "").trim().toLowerCase();

    if (!rawValue) {
      return { enabled: false, error: null };
    }

    if (["1", "on", "true", "yes"].includes(rawValue)) {
      return { enabled: true, error: null };
    }

    if (["0", "off", "false", "no"].includes(rawValue)) {
      return { enabled: false, error: null };
    }

    return { enabled: false, error: name + " must be true or false." };
  },

  resolveRequiredAutomationNumber: function (name, minimum) {
    var rawValue = String(process.env[name] || "").trim();
    var numericValue = Number(rawValue);

    if (!rawValue || !Number.isFinite(numericValue) || numericValue < minimum) {
      return {
        value: null,
        error: name + " must be a number greater than or equal to " + minimum + "."
      };
    }

    return { value: numericValue, error: null };
  },

  resolveHomebridgeAutoOffPolicy: function (homebridgeConfig, verifySSL) {
    var enabledSetting = this.resolveServerAutomationEnabled("HOMEBRIDGE_AUTO_OFF_ENABLED");
    var deviceName;
    var threshold;
    var arm;
    var belowDuration;
    var pollInterval;
    var error;

    if (enabledSetting.error || !enabledSetting.enabled) {
      return { config: null, error: enabledSetting.error };
    }

    if (homebridgeConfig.error || !homebridgeConfig.url || !homebridgeConfig.username) {
      return {
        config: null,
        error: homebridgeConfig.error || "Homebridge server credentials are required when HOMEBRIDGE_AUTO_OFF_ENABLED=true."
      };
    }

    deviceName = String(process.env.HOMEBRIDGE_AUTO_OFF_DEVICE_NAME || "").trim();
    threshold = this.resolveRequiredAutomationNumber("HOMEBRIDGE_AUTO_OFF_THRESHOLD_WATTS", 0.001);
    arm = this.resolveRequiredAutomationNumber("HOMEBRIDGE_AUTO_OFF_ARM_WATTS", 0.001);
    belowDuration = this.resolveRequiredAutomationNumber("HOMEBRIDGE_AUTO_OFF_BELOW_DURATION_MS", 1);
    pollInterval = this.resolveRequiredAutomationNumber("HOMEBRIDGE_AUTO_OFF_POLL_INTERVAL_MS", 5000);
    error = !deviceName ? "HOMEBRIDGE_AUTO_OFF_DEVICE_NAME is required when auto-off is enabled." :
      threshold.error || arm.error || belowDuration.error || pollInterval.error;

    if (!error && arm.value <= threshold.value) {
      error = "HOMEBRIDGE_AUTO_OFF_ARM_WATTS must be greater than HOMEBRIDGE_AUTO_OFF_THRESHOLD_WATTS.";
    }

    if (error) {
      return { config: null, error: error };
    }

    return {
      config: {
        url: homebridgeConfig.url,
        username: homebridgeConfig.username,
        password: homebridgeConfig.password,
        verifySSL: verifySSL,
        allowDiscovery: homebridgeConfig.allowDiscovery,
        enabled: true,
        deviceName: deviceName,
        thresholdWatts: threshold.value,
        armWatts: arm.value,
        belowDuration: belowDuration.value,
        pollInterval: pollInterval.value
      },
      error: null
    };
  },

  initializeServerAutomations: function () {
    var homebridgeConfig = this.resolveHomebridgeConfig();
    var verifySSL = this.resolveHomebridgeVerifySSL();
    var autoOffPolicy = this.resolveHomebridgeAutoOffPolicy(homebridgeConfig, verifySSL);

    this.configureHomebridgeAutoOff(SERVER_AUTO_OFF_MONITOR_ID, autoOffPolicy.config);

    if (autoOffPolicy.error) {
      console.error("[MMM-GoveeSmartHomeStatus] Homebridge auto-off disabled:", autoOffPolicy.error);
    }
  },

  normalizeRefreshInterval: function (value) {
    var parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed < 0) {
      return 0;
    }

    return Math.floor(parsed);
  },

  getCloudCache: function (apiKey) {
    var apiKeyIdentity = String(apiKey || "");
    var cache;

    if (!(this.cloudCaches instanceof Map)) {
      this.cloudCaches = new Map();
    }

    cache = this.cloudCaches.get(apiKeyIdentity);
    if (!cache) {
      cache = {
        devices: [],
        enrichedDevices: [],
        lastListFetchAt: 0,
        lastStateFetchAt: 0
      };
      this.cloudCaches.set(apiKeyIdentity, cache);
    }

    return cache;
  },

  fetchCloudDevicesSegmented: function (apiKey, listIntervalMs, stateIntervalMs, callback) {
    var self = this;
    var now = Date.now();
    var cache = this.getCloudCache(apiKey);
    var listInterval = this.normalizeRefreshInterval(listIntervalMs);
    var stateInterval = this.normalizeRefreshInterval(stateIntervalMs);
    var hasCachedList = cache.devices.length > 0;
    var hasCachedEnriched = cache.enrichedDevices.length > 0;
    var shouldFetchList = !hasCachedList || listInterval === 0 || !cache.lastListFetchAt || (now - cache.lastListFetchAt >= listInterval);
    var shouldFetchState = !hasCachedEnriched || stateInterval === 0 || !cache.lastStateFetchAt || (now - cache.lastStateFetchAt >= stateInterval);

    function done(error, devices) {
      callback(error || null, Array.isArray(devices) ? devices : []);
    }

    function updateStatesForDevices(baseDevices) {
      self.fetchDeviceStates(apiKey, baseDevices, function (enrichedDevices) {
        cache.enrichedDevices = Array.isArray(enrichedDevices) ? enrichedDevices : [];
        cache.lastStateFetchAt = Date.now();
        done(null, cache.enrichedDevices);
      });
    }

    if (shouldFetchList) {
      this.fetchCloudDeviceList(apiKey, function (listError, cloudDevices) {
        if (listError) {
          done(listError);
          return;
        }

        cache.devices = Array.isArray(cloudDevices) ? cloudDevices : [];
        cache.lastListFetchAt = Date.now();

        if (shouldFetchState) {
          updateStatesForDevices(cache.devices);
          return;
        }

        done(null, self.applyCachedStateToCloudDevices(cache.devices, cache.enrichedDevices));
      });

      return;
    }

    if (shouldFetchState) {
      updateStatesForDevices(cache.devices);
      return;
    }

    done(null, cache.enrichedDevices);
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
      var exceededLimit = false;

      res.on("data", function (chunk) {
        data += chunk;
        if (data.length > 1048576) {
          exceededLimit = true;
          req.destroy(new Error("Response body exceeded 1 MB limit"));
        }
      });

      res.on("end", function () {
        if (exceededLimit) {
          return;
        }

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

  applyCachedStateToCloudDevices: function (cloudDevices, cachedEnrichedDevices) {
    var stateById = {};

    if (!Array.isArray(cloudDevices)) {
      return [];
    }

    (Array.isArray(cachedEnrichedDevices) ? cachedEnrichedDevices : []).forEach(function (device) {
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
        color: cachedState.color,
        powerConsumption: cachedState.powerConsumption
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
    var timeout;
    var cancel = function () { finish(null, true); };
    this.trackCleanup(cancel);

    function finish(error, cancelled) {
      if (isDone) {
        return;
      }

      isDone = true;
      clearTimeout(timeout);
      self.pendingCleanups.delete(cancel);

      try {
        socket.close();
      } catch {
        // noop
      }

      if (!cancelled) callback(error || null, discovered);
    }

    socket.on("error", function (error) {
      finish(error);
    });

    socket.on("message", function (message, rinfo) {
      if (isDone) return;
      var parsed;
      var lanDevice;
      var uniqueKey;

      try {
        parsed = JSON.parse(message.toString("utf8"));
      } catch {
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
      if (discovered.length >= 128) {
        return;
      }

      deviceMap[uniqueKey] = true;
      discovered.push(lanDevice);
    });

    socket.bind(LAN_DISCOVERY_LISTEN_PORT, function () {
      if (isDone) return;
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
      } catch {
        // Membership may fail on some interfaces but multicast send can still work.
      }

      // Multicast target used by Govee LAN implementations.
      try {
        socket.send(payload, 0, payload.length, LAN_DISCOVERY_SEND_PORT, LAN_DISCOVERY_GROUP);
      } catch {
        // Ignore send failures here and let timeout-based fallback handle it.
      }

      // Optional unicast targets for cross-subnet environments.
      normalizedTargets.forEach(function (targetIp) {
        try {
          socket.send(payload, 0, payload.length, LAN_DISCOVERY_SEND_PORT, targetIp);
        } catch {
          // Ignore individual unicast send failures and continue probing.
        }
      });
    });

    timeout = setTimeout(function () {
      finish(null);
    }, Math.max(1000, timeoutMs || 4000));
  },

  normalizeLanDevice: function (lanPayload, rinfo) {
    if (!lanPayload || typeof lanPayload !== "object" || Array.isArray(lanPayload) ||
        !lanPayload.msg || typeof lanPayload.msg !== "object" || Array.isArray(lanPayload.msg) ||
        !lanPayload.msg.data || typeof lanPayload.msg.data !== "object" || Array.isArray(lanPayload.msg.data)) {
      console.warn("[MMM-GoveeSmartHomeStatus] Ignored malformed LAN packet.");
      return null;
    }
    var msg = lanPayload && lanPayload.msg ? lanPayload.msg : {};
    var data = msg && msg.data ? msg.data : {};
    if ([msg.cmd, data.device, data.deviceId, lanPayload.device, data.sku, lanPayload.sku,
      data.ip, data.localIp, lanPayload.ip, data.deviceName, data.name, lanPayload.deviceName]
      .some(function (value) { return value != null && typeof value !== "string"; })) {
      console.warn("[MMM-GoveeSmartHomeStatus] Ignored malformed LAN identity.");
      return null;
    }
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
    var timeoutTimer;
    var cancel = function () { finish(true); };

    function finish(cancelled) {
      if (isFinished) {
        return;
      }

      isFinished = true;
      clearTimeout(timeoutTimer);
      if (self.pendingCleanups) self.pendingCleanups.delete(cancel);

      if (sharedSocket) {
        try {
          sharedSocket.close();
        } catch {
          // noop
        }
      }

      if (!cancelled) callback(null, results.filter(function (device) {
        return device !== null;
      }));
    }

    if (!devices.length) {
      callback(null, Array.isArray(lanDevices) ? lanDevices : []);
      return;
    }
    this.trackCleanup(cancel);

    // Create a single shared listener socket for all device probes
    sharedSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });

    sharedSocket.on("error", function () {
      finish();
    });

    sharedSocket.on("message", function (message, rinfo) {
      if (isFinished) return;
      var parsed;
      var responseData;
      var statusDevice;
      var responseIp;

      try {
        parsed = JSON.parse(message.toString("utf8"));
      } catch {
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
      if (isFinished) return;
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
        } catch {
          // Ignore individual send failures and let timeout handling fall back.
        }
      });
    });

    // Set overall timeout for all probes
    timeoutTimer = setTimeout(function () {
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
      console.warn("[MMM-GoveeSmartHomeStatus] GOVEE_LAN_DISCOVERY_TARGETS exceeded max of " + LAN_DISCOVERY_MAX_UNICAST_TARGETS + " expanded IPs. Extra entries were ignored.");
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
    var dedupe = {};
    var merged = [];

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

    lanDevices.forEach(function (lanDevice) {
      if (lanDevice.deviceId) {
        lanById[String(lanDevice.deviceId).toLowerCase()] = lanDevice;
      }
    });

    return cloudDevices.map(function (cloudDevice) {
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
        powerConsumption: cloudDevice.powerConsumption,
        source: "cloud+lan"
      });
    });
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
          color: undefined,
          source: "cloud"
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
      var exceededLimit = false;

      res.on("data", function (chunk) {
        data += chunk;
        if (data.length > 1048576) {
          exceededLimit = true;
          req.destroy(new Error("Response body exceeded 1 MB limit"));
        }
      });

      res.on("end", function () {
        if (exceededLimit) {
          return;
        }

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
      color: this.getCapabilityState(capabilities, ["colorRgb"]),
      source: device.source || "cloud"
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
        return item && typeof item === "object" &&
          item.instance === instanceNames[index] && item.state && typeof item.state === "object";
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
    var normalizedValue = typeof value === "string" ? value.trim().toLowerCase() : value;

    if (typeof value === "boolean") {
      return value;
    }

    if (normalizedValue === 1 || normalizedValue === "1" || normalizedValue === "on" || normalizedValue === "true" || normalizedValue === "yes") {
      return true;
    }

    if (normalizedValue === 0 || normalizedValue === "0" || normalizedValue === "off" || normalizedValue === "false" || normalizedValue === "no") {
      return false;
    }

    return fallbackValue;
  },

  configureHomebridgeAutoOff: function (instanceId, config) {
    var self = this;
    var monitorId = String(instanceId || "__default");
    var existing;
    var configKey;

    if (!this.homebridgeAutoOffMonitors) {
      this.homebridgeAutoOffMonitors = {};
    }
    existing = this.homebridgeAutoOffMonitors[monitorId];

    if (!config || !config.enabled || !config.deviceName) {
      if (existing && existing.timer) {
        clearTimeout(existing.timer);
      }
      delete this.homebridgeAutoOffMonitors[monitorId];
      return;
    }

    configKey = [
      config.url,
      config.username,
      config.password,
      config.verifySSL,
      config.deviceName.toLowerCase(),
      config.thresholdWatts,
      config.armWatts,
      config.belowDuration,
      config.pollInterval
    ].join("\n");

    if (existing && existing.configKey === configKey) {
      return;
    }

    if (existing && existing.timer) {
      clearTimeout(existing.timer);
    }

    this.homebridgeAutoOffMonitors[monitorId] = {
      config: config,
      configKey: configKey,
      armed: monitorId === SERVER_AUTO_OFF_MONITOR_ID && this.loadHomebridgeAutoOffArmedState(config),
      belowSince: null,
      lastReadingAt: null,
      shuttingOff: false,
      persistState: monitorId === SERVER_AUTO_OFF_MONITOR_ID,
      timer: null
    };

    this.homebridgeAutoOffMonitors[monitorId].timer = setTimeout(function () {
      self.pollHomebridgeAutoOff(monitorId);
    }, config.pollInterval);

    if (this.homebridgeAutoOffMonitors[monitorId].timer.unref) {
      this.homebridgeAutoOffMonitors[monitorId].timer.unref();
    }
  },

  scheduleHomebridgeAutoOffPoll: function (monitorId) {
    var self = this;
    var monitor = this.homebridgeAutoOffMonitors[monitorId];

    if (!monitor) {
      return;
    }

    monitor.timer = setTimeout(function () {
      self.pollHomebridgeAutoOff(monitorId);
    }, monitor.config.pollInterval);

    if (monitor.timer.unref) {
      monitor.timer.unref();
    }
  },

  pollHomebridgeAutoOff: function (monitorId) {
    var self = this;
    var monitor = this.homebridgeAutoOffMonitors[monitorId];

    if (!monitor || monitor.shuttingOff) {
      return;
    }

    monitor.timer = null;
    this.fetchHomebridgeOutletMap(
      monitor.config.url,
      monitor.config.username,
      monitor.config.password,
      monitor.config.verifySSL,
      function (error, outletMap) {
        var currentMonitor = self.homebridgeAutoOffMonitors[monitorId];
        var outlet;

        if (!currentMonitor || currentMonitor !== monitor) {
          return;
        }

        if (error) {
          monitor.belowSince = null;
          monitor.lastReadingAt = null;
          console.error("[MMM-GoveeSmartHomeStatus] Homebridge auto-off monitor error:", error.message);
          self.scheduleHomebridgeAutoOffPoll(monitorId);
          return;
        }

        outlet = outletMap[String(monitor.config.deviceName).toLowerCase()];
        if (!outlet) {
          monitor.belowSince = null;
          monitor.lastReadingAt = null;
          console.warn("[MMM-GoveeSmartHomeStatus] Auto-off timer reset: no usable outlet telemetry for " + monitor.config.deviceName);
          self.scheduleHomebridgeAutoOffPoll(monitorId);
          return;
        }
        if (!self.processHomebridgeAutoOffReading(monitor, outlet, Date.now())) {
          self.scheduleHomebridgeAutoOffPoll(monitorId);
          return;
        }

        monitor.shuttingOff = true;
        self.setHomebridgeOutletState(
          monitor.config.url,
          monitor.config.username,
          monitor.config.password,
          monitor.config.verifySSL,
          outlet.uniqueId,
          outlet.characteristicType,
          false,
          function (setError) {
            if (self.homebridgeAutoOffMonitors[monitorId] !== monitor) return;
            monitor.shuttingOff = false;

            if (setError) {
              console.error("[MMM-GoveeSmartHomeStatus] Failed to turn off " + monitor.config.deviceName + ":", setError.message);
            } else {
              self.persistHomebridgeAutoOffArmedState(monitor, false);
              monitor.armed = false;
              monitor.belowSince = null;
              console.log("[MMM-GoveeSmartHomeStatus] Turned off " + monitor.config.deviceName +
                " after sustained low power: " + outlet.watts + "W, threshold " +
                monitor.config.thresholdWatts + "W, duration " + monitor.config.belowDuration + "ms");
            }

            self.scheduleHomebridgeAutoOffPoll(monitorId);
          },
          monitor.config.allowDiscovery
        );
      },
      monitor.config.allowDiscovery
    );
  },

  processHomebridgeAutoOffReading: function (monitor, outlet, now) {
    if (!outlet || outlet.isOn !== true || !Number.isFinite(outlet.watts) || outlet.watts < 0) {
      if (outlet && outlet.isOn === false && monitor.armed) {
        this.persistHomebridgeAutoOffArmedState(monitor, false);
        monitor.armed = false;
      }
      monitor.belowSince = null;
      monitor.lastReadingAt = null;
      return false;
    }

    if (Number.isFinite(monitor.lastReadingAt) &&
        (now < monitor.lastReadingAt || now - monitor.lastReadingAt > monitor.config.pollInterval * 2)) {
      monitor.belowSince = null;
    }
    monitor.lastReadingAt = now;

    if (outlet.watts >= monitor.config.armWatts) {
      if (!monitor.armed) {
        this.persistHomebridgeAutoOffArmedState(monitor, true);
        if (monitor.persistState) {
          console.log("[MMM-GoveeSmartHomeStatus] Armed auto-off for " + monitor.config.deviceName);
        }
      }
      monitor.armed = true;
      monitor.belowSince = null;
      return false;
    }

    if (!monitor.armed || outlet.watts >= monitor.config.thresholdWatts) {
      monitor.belowSince = null;
      return false;
    }

    if (monitor.belowSince === null) {
      monitor.belowSince = now;
      if (monitor.persistState) {
        console.log("[MMM-GoveeSmartHomeStatus] Auto-off low-power timer started for " +
          monitor.config.deviceName + ": " + outlet.watts + "W, threshold " +
          monitor.config.thresholdWatts + "W, required duration " + monitor.config.belowDuration + "ms");
      }
      return false;
    }

    return now - monitor.belowSince >= monitor.config.belowDuration;
  },

  getHomebridgeAutoOffStatePath: function () {
    var stateRoot = String(process.env.XDG_STATE_HOME || "").trim() ||
      path.join(os.homedir(), ".local", "state");

    return path.join(stateRoot, "MMM-GoveeSmartHomeStatus", "homebridge-auto-off.json");
  },

  getHomebridgeAutoOffStateIdentity: function (config) {
    return {
      url: config.url,
      deviceName: String(config.deviceName || "").trim().toLowerCase(),
      thresholdWatts: config.thresholdWatts,
      armWatts: config.armWatts
    };
  },

  loadHomebridgeAutoOffArmedState: function (config) {
    var statePath = this.getHomebridgeAutoOffStatePath();
    var expected = this.getHomebridgeAutoOffStateIdentity(config);
    var state;

    try {
      state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error("[MMM-GoveeSmartHomeStatus] Failed to read auto-off state:", error.message);
      }
      return false;
    }

    if (state.armed === true && state.chargingObserved !== true) {
      console.warn("[MMM-GoveeSmartHomeStatus] Ignoring legacy auto-off armed state; waiting for observed charging at " + config.armWatts + "W or above");
      return false;
    }

    return state.armed === true &&
      state.chargingObserved === true &&
      state.url === expected.url &&
      state.deviceName === expected.deviceName &&
      state.thresholdWatts === expected.thresholdWatts &&
      state.armWatts === expected.armWatts;
  },

  persistHomebridgeAutoOffArmedState: function (monitor, armed) {
    var statePath;
    var temporaryPath;
    var state;

    if (!monitor.persistState) {
      return;
    }

    statePath = this.getHomebridgeAutoOffStatePath();
    temporaryPath = statePath + "." + process.pid + ".tmp";

    if (!armed) {
      try {
        fs.unlinkSync(statePath);
      } catch (error) {
        if (error.code !== "ENOENT") {
          console.error("[MMM-GoveeSmartHomeStatus] Failed to clear auto-off state:", error.message);
        }
      }
      return;
    }

    state = Object.assign(this.getHomebridgeAutoOffStateIdentity(monitor.config), {
      armed: true,
      chargingObserved: true
    });

    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporaryPath, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporaryPath, statePath);
    } catch (error) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") {
          console.error("[MMM-GoveeSmartHomeStatus] Failed to clean up temporary auto-off state:", cleanupError.message);
        }
      }
      console.error("[MMM-GoveeSmartHomeStatus] Failed to persist auto-off state:", error.message);
    }
  },

  generateRequestId: function () {
    return "govee-" + Date.now() + "-" + Math.floor(Math.random() * 1000000);
  }
});
