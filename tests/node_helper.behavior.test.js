const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
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
    document: {
      createElement() {
        return {
          children: [],
          classList: { add() {} },
          appendChild(child) {
            this.children.push(child);
          }
        };
      }
    },
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

test("frontend defaults Homebridge TLS verification on while preserving auto-off defaults", () => {
  const { definition } = loadFrontendModule();
  let requestPayload;
  const moduleInstance = Object.assign({}, definition, {
    config: Object.assign({}, definition.defaults, {
      apiKey: "test-key",
      homebridgeUrl: "https://homebridge.local:8581"
    }),
    identifier: "test-instance",
    sendSocketNotification(notification, payload) {
      if (notification === "GOVEE_DEVICES_REQUEST") {
        requestPayload = payload;
      }
    },
    updateDom() {}
  });

  moduleInstance.start();

  assert.equal(requestPayload.homebridgeVerifySSL, true);
  assert.equal(requestPayload.homebridgeAutoOffEnabled, true);
  assert.equal(requestPayload.homebridgeAutoOffDeviceName, "eBike - Pro");
});

test("frontend waits for server data when the API key is environment-only", () => {
  const { definition } = loadFrontendModule();
  const moduleInstance = Object.assign({}, definition, {
    config: Object.assign({}, definition.defaults, { apiKey: "" }),
    dataState: {
      devices: [],
      fetchedAt: null,
      error: null,
      loading: true
    }
  });

  const dom = moduleInstance.getDom();
  const messages = dom.children.map((child) => child.textContent);

  assert.ok(messages.includes(definition.defaults.loadingMessage));
  assert.ok(!messages.includes(definition.defaults.noApiKeyMessage));
});

test("full-width bottom bar keeps wattage visible", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "MMM-GoveeSmartHomeStatus.css"), "utf8");
  const hiddenDetailsIndex = css.indexOf(".full-width-bottom-bar .device-detail {");
  const visibleWattageIndex = css.indexOf(".full-width-bottom-bar .device-detail.device-watt {");

  assert.ok(hiddenDetailsIndex !== -1);
  assert.ok(visibleWattageIndex > hiddenDetailsIndex);
  assert.match(css.slice(visibleWattageIndex), /display: inline;/);
});

test("grouped bottom bar fits room cards within the available width", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "MMM-GoveeSmartHomeStatus.css"), "utf8");
  const listRule = css.match(/\.full-width-bottom-bar \.compact-card-list\.grouped-by-room \{([^}]+)\}/);
  const roomRule = css.match(/\.full-width-bottom-bar \.compact-room-cards \{([^}]+)\}/);

  assert.ok(listRule);
  assert.match(listRule[1], /width: 100%;/);
  assert.match(listRule[1], /flex-wrap: wrap;/);
  assert.doesNotMatch(listRule[1], /width: max-content;/);
  assert.ok(roomRule);
  assert.match(roomRule[1], /grid-template-rows: repeat\(3,/);
});

test("compact cards group by configured room order with local device names", () => {
  const { definition } = loadFrontendModule();
  const moduleInstance = Object.assign({}, definition, {
    config: Object.assign({}, definition.defaults, {
      roomOrder: ["Office", "Living Room"]
    })
  });
  const devices = [
    { deviceName: "Living Room - Right", powerState: false },
    { deviceName: "Office - Work Right", powerState: true },
    { deviceName: "Hallway", powerState: true },
    { deviceName: "Office - Work Left", powerState: false }
  ];

  const groups = moduleInstance.buildCompactRoomGroups(devices);

  assert.deepEqual(Array.from(groups, (group) => group.room), ["Office", "Living Room", "Unassigned"]);
  assert.deepEqual(Array.from(groups[0].devices, (device) => device.deviceName), ["Office - Work Left", "Office - Work Right"]);
  assert.equal(groups[0].on, 1);
  assert.equal(groups[0].total, 2);
  assert.equal(moduleInstance.getGroupedDeviceName(groups[0].devices[0], "Office"), "Work Left");
  assert.equal(moduleInstance.getGroupedDeviceName(devices[2], "Unassigned"), "Hallway");
});

test("compact-card limits retain representation from each room", () => {
  const { definition } = loadFrontendModule();
  const moduleInstance = Object.assign({}, definition, {
    config: Object.assign({}, definition.defaults, {
      groupCompactCardsByRoom: true
    })
  });
  const devices = [
    { deviceName: "Bedroom - Left" },
    { deviceName: "Bedroom - Right" },
    { deviceName: "Kitchen - Left" },
    { deviceName: "Kitchen - Right" },
    { deviceName: "Office - Left" },
    { deviceName: "Office - Right" }
  ];

  const selected = moduleInstance.selectCompactCardDevices(devices, 3);

  assert.deepEqual(Array.from(selected, (device) => moduleInstance.inferRoomName(device)), ["Bedroom", "Kitchen", "Office"]);
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

test("server Homebridge credentials ignore renderer origins and disable discovery", async () => {
  const previousUrl = process.env.HOMEBRIDGE_URL;
  const previousUsername = process.env.HOMEBRIDGE_USERNAME;
  const previousPassword = process.env.HOMEBRIDGE_PASSWORD;
  const originalFetch = helper.fetchHomebridgePowerMapAtUrl;
  const originalDiscover = helper.discoverHomebridgeUrl;
  let discoveryAttempted = false;

  process.env.HOMEBRIDGE_URL = "https://trusted.example:8581";
  process.env.HOMEBRIDGE_USERNAME = "server-user";
  process.env.HOMEBRIDGE_PASSWORD = "server-password";
  helper.homebridgeFallbackUrls = {};

  try {
    const config = helper.resolveHomebridgeConfig({
      homebridgeUrl: "https://attacker.example",
      homebridgeUsername: "renderer-user",
      homebridgePassword: "renderer-password"
    });

    assert.deepEqual(config, {
      url: "https://trusted.example:8581",
      username: "server-user",
      password: "server-password",
      allowDiscovery: false,
      error: null
    });

    helper.fetchHomebridgePowerMapAtUrl = (url, username, password, verifySSL, callback) => {
      assert.equal(url, "https://trusted.example:8581");
      const error = new Error("getaddrinfo ENOTFOUND trusted.example");
      error.code = "ENOTFOUND";
      callback(error, null);
    };
    helper.discoverHomebridgeUrl = () => {
      discoveryAttempted = true;
    };

    await new Promise((resolve) => {
      helper.fetchHomebridgePowerMap(
        config.url,
        config.username,
        config.password,
        true,
        (error) => {
          assert.match(error.message, /ENOTFOUND/);
          resolve();
        },
        config.allowDiscovery
      );
    });

    assert.equal(discoveryAttempted, false);
  } finally {
    helper.fetchHomebridgePowerMapAtUrl = originalFetch;
    helper.discoverHomebridgeUrl = originalDiscover;
    helper.homebridgeFallbackUrls = {};
    const values = {
      HOMEBRIDGE_URL: previousUrl,
      HOMEBRIDGE_USERNAME: previousUsername,
      HOMEBRIDGE_PASSWORD: previousPassword
    };
    Object.entries(values).forEach(([name, value]) => {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    });
  }
});

test("server Homebridge credentials require a trusted server URL", () => {
  const previousUrl = process.env.HOMEBRIDGE_URL;
  const previousUsername = process.env.HOMEBRIDGE_USERNAME;
  const previousPassword = process.env.HOMEBRIDGE_PASSWORD;
  delete process.env.HOMEBRIDGE_URL;
  process.env.HOMEBRIDGE_USERNAME = "server-user";
  process.env.HOMEBRIDGE_PASSWORD = "server-password";

  try {
    const config = helper.resolveHomebridgeConfig({
      homebridgeUrl: "https://attacker.example"
    });
    assert.match(config.error, /HOMEBRIDGE_URL is required/);
    assert.equal(config.url, "");
  } finally {
    const values = {
      HOMEBRIDGE_URL: previousUrl,
      HOMEBRIDGE_USERNAME: previousUsername,
      HOMEBRIDGE_PASSWORD: previousPassword
    };
    Object.entries(values).forEach(([name, value]) => {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    });
  }
});

test("server Homebridge TLS verification uses the server environment", () => {
  const previousValues = {
    HOMEBRIDGE_USERNAME: process.env.HOMEBRIDGE_USERNAME,
    HOMEBRIDGE_PASSWORD: process.env.HOMEBRIDGE_PASSWORD,
    HOMEBRIDGE_VERIFY_SSL: process.env.HOMEBRIDGE_VERIFY_SSL
  };
  process.env.HOMEBRIDGE_USERNAME = "server-user";
  process.env.HOMEBRIDGE_PASSWORD = "server-password";

  try {
    delete process.env.HOMEBRIDGE_VERIFY_SSL;
    assert.equal(helper.resolveHomebridgeVerifySSL({ homebridgeVerifySSL: false }), true);

    process.env.HOMEBRIDGE_VERIFY_SSL = " false\r";
    assert.equal(helper.resolveHomebridgeVerifySSL({ homebridgeVerifySSL: true }), false);
  } finally {
    Object.entries(previousValues).forEach(([name, value]) => {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    });
  }
});

test("renderer Homebridge origins require an exact server allowlist match", () => {
  const previousValues = {
    HOMEBRIDGE_URL: process.env.HOMEBRIDGE_URL,
    HOMEBRIDGE_USERNAME: process.env.HOMEBRIDGE_USERNAME,
    HOMEBRIDGE_PASSWORD: process.env.HOMEBRIDGE_PASSWORD,
    HOMEBRIDGE_ALLOWED_ORIGINS: process.env.HOMEBRIDGE_ALLOWED_ORIGINS
  };
  delete process.env.HOMEBRIDGE_URL;
  delete process.env.HOMEBRIDGE_USERNAME;
  delete process.env.HOMEBRIDGE_PASSWORD;
  delete process.env.HOMEBRIDGE_ALLOWED_ORIGINS;

  try {
    const metadataConfig = helper.resolveHomebridgeConfig({
      homebridgeUrl: "http://169.254.169.254",
      homebridgeUsername: "renderer-user"
    });
    assert.match(metadataConfig.error, /must exactly match/);
    assert.equal(metadataConfig.url, "");

    process.env.HOMEBRIDGE_ALLOWED_ORIGINS = "http://127.0.0.1:8581, https://Homebridge.Local:8581/";
    const loopbackConfig = helper.resolveHomebridgeConfig({
      homebridgeUrl: "http://127.0.0.1:8581",
      homebridgeUsername: "renderer-user"
    });
    assert.equal(loopbackConfig.url, "http://127.0.0.1:8581");
    assert.equal(loopbackConfig.error, null);

    const localConfig = helper.resolveHomebridgeConfig({
      homebridgeUrl: "https://homebridge.local:8581",
      homebridgeUsername: "renderer-user",
      homebridgePassword: "renderer-password"
    });
    assert.deepEqual(localConfig, {
      url: "https://homebridge.local:8581",
      username: "renderer-user",
      password: "renderer-password",
      allowDiscovery: false,
      error: null
    });

    const pathConfig = helper.resolveHomebridgeConfig({
      homebridgeUrl: "https://homebridge.local:8581/admin",
      homebridgeUsername: "renderer-user"
    });
    assert.match(pathConfig.error, /without a path/);
  } finally {
    Object.entries(previousValues).forEach(([name, value]) => {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    });
  }
});

test("Homebridge token cache is isolated by canonical origin and username", async () => {
  const originalAuthenticate = helper.authenticateHomebridge;
  const authenticationCalls = [];
  helper.homebridgeTokenCache = new Map();
  helper.authenticateHomebridge = (url, username, password, verifySSL, callback) => {
    authenticationCalls.push({ url, username });
    callback(null, url + "::" + username, Date.now() + 60000);
  };

  function getToken(url, username) {
    return new Promise((resolve, reject) => {
      helper.withHomebridgeToken(url, username, "password", true, (error, token) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(token);
      });
    });
  }

  try {
    const firstToken = await getToken("https://Homebridge.Example:443/", "alice");
    const canonicalToken = await getToken("https://homebridge.example", "alice");
    const secondUserToken = await getToken("https://homebridge.example", "bob");
    const secondOriginToken = await getToken("https://other.example", "alice");

    assert.equal(firstToken, canonicalToken);
    assert.notEqual(firstToken, secondUserToken);
    assert.notEqual(firstToken, secondOriginToken);
    assert.equal(authenticationCalls.length, 3);

    const firstCacheKey = helper.getHomebridgeTokenCacheKey("https://homebridge.example", "alice");
    helper.homebridgeTokenCache.get(firstCacheKey).expiresAt = Date.now() - 1;
    const refreshedToken = await getToken("https://homebridge.example", "alice");
    assert.equal(authenticationCalls.length, 4);

    helper.invalidateHomebridgeToken("https://homebridge.example", "alice", refreshedToken);
    assert.equal(helper.homebridgeTokenCache.size, 2);
    assert.ok(helper.homebridgeTokenCache.has(helper.getHomebridgeTokenCacheKey("https://homebridge.example", "bob")));
    assert.ok(helper.homebridgeTokenCache.has(helper.getHomebridgeTokenCacheKey("https://other.example", "alice")));
  } finally {
    helper.authenticateHomebridge = originalAuthenticate;
    helper.homebridgeTokenCache = new Map();
  }
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

test("Homebridge outlet map retains writable On characteristic identifiers", () => {
  const accessories = [{
    aid: 4,
    uniqueId: "outlet-service-id",
    accessoryInformation: { Name: "eBike - Pro" },
    serviceCharacteristics: [
      {
        uuid: "E863F10D-079E-48FF-8F27-9C2605A29F52",
        serviceName: "Outlet Pro",
        value: "4.25"
      },
      {
        uuid: "00000025-0000-1000-8000-0026BB765291",
        iid: 9,
        type: "On",
        serviceName: "Outlet Pro",
        value: true,
        canWrite: true
      }
    ]
  }];

  assert.deepEqual(helper.buildHomebridgeOutletMap(accessories), {
    "ebike - pro": {
      watts: 4.3,
      isOn: true,
      uniqueId: "outlet-service-id",
      characteristicType: "On"
    },
    "outlet pro": {
      watts: 4.3,
      isOn: true,
      uniqueId: "outlet-service-id",
      characteristicType: "On"
    }
  });
});

test("Homebridge auto-off requires charging and sustained power below threshold", () => {
  const monitor = {
    config: {
      thresholdWatts: 5,
      armWatts: 20,
      belowDuration: 300000
    },
    armed: false,
    belowSince: null
  };

  assert.equal(helper.processHomebridgeAutoOffReading(monitor, { watts: 3, isOn: true }, 1000), false);
  assert.equal(monitor.armed, false);
  assert.equal(helper.processHomebridgeAutoOffReading(monitor, { watts: 25, isOn: true }, 2000), false);
  assert.equal(monitor.armed, true);
  assert.equal(helper.processHomebridgeAutoOffReading(monitor, { watts: 4.9, isOn: true }, 3000), false);
  assert.equal(helper.processHomebridgeAutoOffReading(monitor, { watts: 4.9, isOn: true }, 302999), false);
  assert.equal(helper.processHomebridgeAutoOffReading(monitor, { watts: 4.9, isOn: true }, 303000), true);
});

test("Homebridge characteristic writer sends outlet off command", async () => {
  const originalRequest = http.request;
  let requestOptions;
  let requestBody;

  http.request = (options, responseCallback) => {
    const request = new EventEmitter();
    request.write = (body) => {
      requestBody = body;
    };
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      responseCallback(response);
      response.emit("end");
    };
    request.destroy = (error) => request.emit("error", error);
    requestOptions = options;
    return request;
  };

  try {
    await new Promise((resolve, reject) => {
      helper.writeHomebridgeCharacteristic(
        "http://homebridge.local:8581",
        "test-token",
        false,
        "outlet-service-id",
        "On",
        false,
        (error) => error ? reject(error) : resolve()
      );
    });

    assert.equal(requestOptions.method, "PUT");
    assert.equal(requestOptions.path, "/api/accessories/outlet-service-id");
    assert.equal(requestOptions.headers.Authorization, "Bearer test-token");
    assert.equal(requestBody, '{"characteristicType":"On","value":false}');
  } finally {
    http.request = originalRequest;
  }
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

test("Govee cloud caches remain isolated when different API key requests race", async () => {
  const originalFetchList = helper.fetchCloudDeviceList;
  const originalFetchStates = helper.fetchDeviceStates;
  const listCallbacks = new Map();
  helper.cloudCaches = new Map();
  helper.fetchCloudDeviceList = (apiKey, callback) => {
    listCallbacks.set(apiKey, callback);
  };
  helper.fetchDeviceStates = (apiKey, devices, callback) => {
    callback(devices.map((device) => Object.assign({}, device, {
      apiKey,
      powerState: apiKey === "key-b"
    })));
  };

  function fetchForKey(apiKey) {
    return new Promise((resolve, reject) => {
      helper.fetchCloudDevicesSegmented(apiKey, 60000, 60000, (error, devices) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(devices);
      });
    });
  }

  try {
    const keyAResult = fetchForKey("key-a");
    const keyBResult = fetchForKey("key-b");

    listCallbacks.get("key-b")(null, [{ deviceId: "device-b" }]);
    listCallbacks.get("key-a")(null, [{ deviceId: "device-a" }]);

    assert.deepEqual(await keyBResult, [{
      deviceId: "device-b",
      apiKey: "key-b",
      powerState: true
    }]);
    assert.deepEqual(await keyAResult, [{
      deviceId: "device-a",
      apiKey: "key-a",
      powerState: false
    }]);
    assert.deepEqual(helper.getCloudCache("key-a").enrichedDevices, [{
      deviceId: "device-a",
      apiKey: "key-a",
      powerState: false
    }]);
    assert.deepEqual(helper.getCloudCache("key-b").enrichedDevices, [{
      deviceId: "device-b",
      apiKey: "key-b",
      powerState: true
    }]);
  } finally {
    helper.fetchCloudDeviceList = originalFetchList;
    helper.fetchDeviceStates = originalFetchStates;
    helper.cloudCaches = new Map();
  }
});