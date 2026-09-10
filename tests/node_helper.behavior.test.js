const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const vm = require("node:vm");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "node_helper") {
    return {
      create(definition) {
        return definition;
      }
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

const helper = require("../node_helper");
Module._load = originalLoad;

function loadFrontendModule() {
  const source = fs.readFileSync(path.join(__dirname, "..", "MMM-GoveeSmartHomeStatus.js"), "utf8");
  let definition;
  let nextTimerId = 1;
  const timers = new Map();
  const context = {
    Module: {
      register(name, moduleDefinition) {
        definition = moduleDefinition;
      }
    },
    console: { warn() {} },
    clearTimeout(timerId) {
      timers.delete(timerId);
    },
    setTimeout(callback, delay) {
      const timerId = nextTimerId++;
      timers.set(timerId, { callback, delay });
      return timerId;
    }
  };

  vm.runInNewContext(source, context);
  return { definition, timers };
}

test("frontend continues retrying after more than three connection failures", () => {
  const { definition, timers } = loadFrontendModule();
  const moduleInstance = Object.assign({}, definition, {
    config: Object.assign({}, definition.defaults, { apiKey: "test-key" }),
    identifier: "test-instance",
    sendSocketNotification() {},
    updateDom() {}
  });

  moduleInstance.start();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    moduleInstance.socketNotificationReceived("GOVEE_DEVICES_ERROR", {
      instanceId: "test-instance",
      error: "Network unavailable"
    });

    const retryTimer = timers.get(moduleInstance.configRetryTimer);
    assert.ok(retryTimer, "retry timer should remain scheduled after failure " + (attempt + 1));
    retryTimer.callback();
  }

  assert.equal(moduleInstance.configRetryCount, 5);
  assert.equal(moduleInstance.dataState.loading, true);
  assert.ok(timers.has(moduleInstance.configRetryTimer));
});

test("full-width bottom bar keeps wattage visible", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "MMM-GoveeSmartHomeStatus.css"), "utf8");
  const hiddenDetailsIndex = css.indexOf(".full-width-bottom-bar .device-detail {");
  const visibleWattageIndex = css.indexOf(".full-width-bottom-bar .device-detail.device-watt {");

  assert.ok(hiddenDetailsIndex !== -1);
  assert.ok(visibleWattageIndex > hiddenDetailsIndex);
  assert.match(css.slice(visibleWattageIndex), /display: inline;/);
});

test("Homebridge accessory API explains the insecure mode requirement", () => {
  const message = helper.getHomebridgeAccessoriesError(400, "Bad Request", {
    message: "Homebridge must be running in insecure mode to access accessories."
  });

  assert.match(message, /requires insecure mode \(-I\)/);
});

test("Homebridge discovery preserves HTTPS and requires a matching web service port", () => {
  const service = {
    name: "Homebridge DC",
    port: 8581,
    addresses: ["fe80::1", "192.0.2.18"]
  };

  assert.equal(
    helper.getHomebridgeDiscoveryUrl("https://missing.example.com:8581", service),
    "https://192.0.2.18:8581"
  );
  assert.equal(
    helper.getHomebridgeDiscoveryUrl("https://missing.example.com:443", service),
    null
  );
});

test("Homebridge power retries through discovery only after DNS failure", async () => {
  const originalFetch = helper.fetchHomebridgePowerMapAtUrl;
  const originalDiscover = helper.discoverHomebridgeUrl;
  const attempts = [];

  helper.homebridgeFallbackUrls = {};
  helper.fetchHomebridgePowerMapAtUrl = (url, username, password, verifySSL, callback) => {
    attempts.push(url);
    assert.equal(verifySSL, true);
    if (attempts.length === 1) {
      const error = new Error("getaddrinfo ENOTFOUND missing.example.com");
      error.code = "ENOTFOUND";
      callback(error, null);
      return;
    }
    callback(null, { "ebike - pro": 175 });
  };
  helper.discoverHomebridgeUrl = (url, callback) => callback(null, "https://192.0.2.18:8581");

  try {
    const powerMap = await new Promise((resolve, reject) => {
      helper.fetchHomebridgePowerMap("https://missing.example.com:8581", "user", "password", true, (error, result) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(result);
      });
    });

    assert.deepEqual(attempts, ["https://missing.example.com:8581", "https://192.0.2.18:8581"]);
    assert.equal(powerMap["ebike - pro"], 175);
  } finally {
    helper.fetchHomebridgePowerMapAtUrl = originalFetch;
    helper.discoverHomebridgeUrl = originalDiscover;
    helper.homebridgeFallbackUrls = {};
  }
});

test("Homebridge authentication verifies TLS unless explicitly disabled", async () => {
  const originalRequest = https.request;
  const rejectUnauthorizedValues = [];

  https.request = (options, responseCallback) => {
    const request = new EventEmitter();
    request.write = () => {};
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      rejectUnauthorizedValues.push(options.rejectUnauthorized);
      responseCallback(response);
      response.emit("data", Buffer.from('{"access_token":"test-token","expires_in":600}'));
      response.emit("end");
    };
    request.destroy = (error) => request.emit("error", error);
    return request;
  };

  try {
    for (const verifySSL of [true, false]) {
      await new Promise((resolve, reject) => {
        helper.authenticateHomebridge("https://homebridge.example:8581", "user", "password", verifySSL, (error, token) => {
          if (error) {
            reject(error);
            return;
          }
          assert.equal(token, "test-token");
          resolve();
        });
      });
    }

    assert.deepEqual(rejectUnauthorizedValues, [true, false]);
  } finally {
    https.request = originalRequest;
  }
});

test("Homebridge power map accepts Outlet Pro characteristic variants", () => {
  const accessories = [{
    accessoryInformation: {
      Name: "Homebridge Outlet Name",
      "Serial Number": "AA:BB:CC:DD"
    },
    serviceCharacteristics: [{
      uuid: "e863f10d-079e-48ff-8f27-9c2605a29f52",
      serviceName: "Outlet Pro",
      value: "12.34"
    }]
  }];

  assert.deepEqual(helper.buildHomebridgePowerMap(accessories), {
    "homebridge outlet name": 12.3,
    "aa:bb:cc:dd": 12.3,
    "outlet pro": 12.3
  });
});

test("Homebridge power matches Govee device ID when display names differ", () => {
  const devices = [{
    deviceId: "AA:BB:CC:DD",
    deviceName: "Govee Outlet Name"
  }];
  const powerMap = {
    "aa:bb:cc:dd": 18.7,
    "homebridge outlet name": 18.7
  };

  assert.deepEqual(helper.applyHomebridgePower(devices, powerMap), [{
    deviceId: "AA:BB:CC:DD",
    deviceName: "Govee Outlet Name",
    powerConsumption: 18.7
  }]);
});

test("Homebridge power map retains zero watts and rejects invalid readings", () => {
  const accessories = [
    {
      accessoryInformation: { Name: "Idle Outlet" },
      serviceCharacteristics: [{
        uuid: "E863F10D-079E-48FF-8F27-9C2605A29F52",
        value: 0
      }]
    },
    {
      accessoryInformation: { Name: "Invalid Outlet" },
      serviceCharacteristics: [{
        uuid: "E863F10D-079E-48FF-8F27-9C2605A29F52",
        value: "unknown"
      }]
    }
  ];

  assert.deepEqual(helper.buildHomebridgePowerMap(accessories), {
    "idle outlet": 0
  });
});

test("server Govee API key takes precedence over renderer config", () => {
  const previousApiKey = process.env.GOVEE_API_KEY;
  const originalFetch = helper.fetchCloudDevicesSegmented;
  const originalSend = helper.sendDevicesData;
  let receivedApiKey;

  process.env.GOVEE_API_KEY = "server-key";
  helper.fetchCloudDevicesSegmented = (apiKey, listInterval, stateInterval, callback) => {
    receivedApiKey = apiKey;
    callback(null, []);
  };
  helper.sendDevicesData = () => {};

  try {
    helper.fetchGoveeDevices({ apiKey: "renderer-key" });
    assert.equal(receivedApiKey, "server-key");
  } finally {
    helper.fetchCloudDevicesSegmented = originalFetch;
    helper.sendDevicesData = originalSend;
    if (previousApiKey === undefined) {
      delete process.env.GOVEE_API_KEY;
    } else {
      process.env.GOVEE_API_KEY = previousApiKey;
    }
  }
});