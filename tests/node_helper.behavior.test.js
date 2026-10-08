const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
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

const SERVER_AUTOMATION_ENV_NAMES = [
  "HOMEBRIDGE_URL",
  "HOMEBRIDGE_USERNAME",
  "HOMEBRIDGE_PASSWORD",
  "HOMEBRIDGE_VERIFY_SSL",
  "HOMEBRIDGE_AUTO_OFF_ENABLED",
  "HOMEBRIDGE_AUTO_OFF_DEVICE_NAME",
  "HOMEBRIDGE_AUTO_OFF_THRESHOLD_WATTS",
  "HOMEBRIDGE_AUTO_OFF_ARM_WATTS",
  "HOMEBRIDGE_AUTO_OFF_BELOW_DURATION_MS",
  "HOMEBRIDGE_AUTO_OFF_POLL_INTERVAL_MS",
  "PRESENCE_DISPLAY_CONTROL_ENABLED",
  "PRESENCE_DISPLAY_SENSOR_NAME",
  "PRESENCE_DISPLAY_OFF_DELAY_MS",
  "PRESENCE_DISPLAY_POLL_INTERVAL_MS",
  "PRESENCE_DISPLAY_OUTPUT"
];

function replaceServerAutomationEnvironment(values) {
  const previousValues = Object.fromEntries(
    SERVER_AUTOMATION_ENV_NAMES.map((name) => [name, process.env[name]])
  );

  SERVER_AUTOMATION_ENV_NAMES.forEach((name) => delete process.env[name]);
  Object.entries(values || {}).forEach(([name, value]) => {
    process.env[name] = value;
  });

  return function restore() {
    Object.entries(previousValues).forEach(([name, value]) => {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    });
  };
}

function clearAutomationMonitors() {
  Object.values(helper.homebridgeAutoOffMonitors || {}).forEach((monitor) => clearTimeout(monitor.timer));
  Object.values(helper.presenceDisplayMonitors || {}).forEach((monitor) => clearTimeout(monitor.timer));
  helper.homebridgeAutoOffMonitors = {};
  helper.presenceDisplayMonitors = {};
}

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
    config: Object.assign({}, definition.defaults),
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

test("frontend request omits all server-only secrets and automation policy", () => {
  const { definition } = loadFrontendModule();
  let requestPayload;
  const moduleInstance = Object.assign({}, definition, {
    config: Object.assign({}, definition.defaults, {
      apiKey: "renderer-key",
      homebridgeUrl: "https://attacker.example",
      homebridgeUsername: "renderer-user",
      homebridgePassword: "renderer-password",
      homebridgeAutoOffEnabled: true,
      homebridgeAutoOffDeviceName: "Attacker Outlet",
      homebridgeAutoOffThresholdWatts: 999,
      homebridgeAutoOffArmWatts: 1000,
      homebridgeAutoOffBelowDuration: 1,
      homebridgeAutoOffPollInterval: 1,
      presenceDisplayControlEnabled: true,
      presenceDisplaySensorName: "Attacker Sensor",
      presenceDisplayOffDelay: 1,
      presenceDisplayPollInterval: 1,
      presenceDisplayOutput: "ATTACKER-1"
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

  assert.equal(Object.hasOwn(requestPayload, "apiKey"), false);
  assert.equal(Object.hasOwn(requestPayload, "homebridgeUrl"), false);
  assert.equal(Object.hasOwn(requestPayload, "homebridgeUsername"), false);
  assert.equal(Object.hasOwn(requestPayload, "homebridgePassword"), false);
  assert.equal(Object.hasOwn(requestPayload, "homebridgeVerifySSL"), false);
  [
    "homebridgeAutoOffEnabled",
    "homebridgeAutoOffDeviceName",
    "homebridgeAutoOffThresholdWatts",
    "homebridgeAutoOffArmWatts",
    "homebridgeAutoOffBelowDuration",
    "homebridgeAutoOffPollInterval",
    "presenceDisplayControlEnabled",
    "presenceDisplaySensorName",
    "presenceDisplayOffDelay",
    "presenceDisplayPollInterval",
    "presenceDisplayOutput"
  ].forEach((name) => assert.equal(Object.hasOwn(requestPayload, name), false));
});

test("frontend waits for server data when the API key is environment-only", () => {
  const { definition } = loadFrontendModule();
  const moduleInstance = Object.assign({}, definition, {
    config: Object.assign({}, definition.defaults),
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
  assert.match(roomRule[1], /grid-template-rows: repeat\(2,/);
  assert.match(roomRule[1], /grid-auto-columns: clamp\(54px, 4vw, 80px\);/);
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
    assert.equal(helper.resolveHomebridgeVerifySSL(), true);

    process.env.HOMEBRIDGE_VERIFY_SSL = " false\r";
    assert.equal(helper.resolveHomebridgeVerifySSL(), false);
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

test("renderer Homebridge settings are ignored when server integration is not configured", () => {
  const previousValues = {
    HOMEBRIDGE_URL: process.env.HOMEBRIDGE_URL,
    HOMEBRIDGE_USERNAME: process.env.HOMEBRIDGE_USERNAME,
    HOMEBRIDGE_PASSWORD: process.env.HOMEBRIDGE_PASSWORD
  };
  delete process.env.HOMEBRIDGE_URL;
  delete process.env.HOMEBRIDGE_USERNAME;
  delete process.env.HOMEBRIDGE_PASSWORD;

  try {
    const config = helper.resolveHomebridgeConfig({
      homebridgeUrl: "https://homebridge.local:8581",
      homebridgeUsername: "renderer-user",
      homebridgePassword: "renderer-password"
    });
    assert.deepEqual(config, {
      url: "",
      username: "",
      password: "",
      allowDiscovery: false,
      error: null
    });
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

test("Homebridge auto-off preserves an armed charging cycle across restarts", () => {
  const previousStateHome = process.env.XDG_STATE_HOME;
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "govee-auto-off-"));
  const config = {
    url: "https://homebridge.local:8581",
    deviceName: "eBike - Pro",
    thresholdWatts: 6,
    armWatts: 20
  };
  const monitor = {
    config,
    armed: false,
    belowSince: null,
    persistState: true
  };

  process.env.XDG_STATE_HOME = stateHome;

  try {
    assert.equal(helper.processHomebridgeAutoOffReading(monitor, { watts: 25, isOn: true }, 1000), false);
    assert.equal(helper.loadHomebridgeAutoOffArmedState(config), true);
    assert.equal(helper.loadHomebridgeAutoOffArmedState({
      ...config,
      deviceName: "Different Outlet"
    }), false);

    monitor.armed = true;
    assert.equal(helper.processHomebridgeAutoOffReading(monitor, { watts: 0, isOn: false }, 2000), false);
    assert.equal(helper.loadHomebridgeAutoOffArmedState(config), false);
  } finally {
    if (previousStateHome === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previousStateHome;
    }
    fs.rmSync(stateHome, { recursive: true, force: true });
  }
});

test("Homebridge occupancy map reads presence sensor state", () => {
  const accessories = [{
    accessoryInformation: { Name: "Hallway - Sensor" },
    serviceCharacteristics: [{
      uuid: "00000071-0000-1000-8000-0026BB765291",
      serviceName: "Hallway - Sensor",
      value: 0
    }]
  }];

  assert.deepEqual(helper.buildHomebridgeOccupancyMap(accessories), {
    "hallway - sensor": false
  });
});

test("presence display waits five minutes to turn off and wakes immediately", () => {
  const monitor = {
    config: { offDelay: 300000 },
    absentSince: null,
    displayOn: true
  };

  assert.equal(helper.processPresenceDisplayReading(monitor, false, 1000), null);
  assert.equal(helper.processPresenceDisplayReading(monitor, false, 300999), null);
  assert.equal(helper.processPresenceDisplayReading(monitor, false, 301000), "off");

  monitor.displayOn = false;
  assert.equal(helper.processPresenceDisplayReading(monitor, true, 302000), "on");
  assert.equal(monitor.absentSince, null);
});

test("malicious renderer automation settings cannot create privileged monitors", () => {
  const restoreEnvironment = replaceServerAutomationEnvironment({
    HOMEBRIDGE_URL: "https://trusted.example:8581",
    HOMEBRIDGE_USERNAME: "server-user",
    HOMEBRIDGE_PASSWORD: "server-password"
  });
  const previousApiKey = process.env.GOVEE_API_KEY;
  const originalFetch = helper.fetchCloudDevicesSegmented;
  const originalWithPower = helper.withHomebridgePower;
  const originalSend = helper.sendDevicesData;
  const originalSetOutlet = helper.setHomebridgeOutletState;
  const originalSetDisplay = helper.setDisplayPower;
  let outletWrites = 0;
  let displayWrites = 0;

  process.env.GOVEE_API_KEY = "server-key";
  helper.fetchCloudDevicesSegmented = (apiKey, listInterval, stateInterval, callback) => callback(null, []);
  helper.withHomebridgePower = (url, username, password, verifySSL, devices, callback) => callback(devices);
  helper.sendDevicesData = () => {};
  helper.setHomebridgeOutletState = () => {
    outletWrites += 1;
  };
  helper.setDisplayPower = () => {
    displayWrites += 1;
  };

  try {
    clearAutomationMonitors();
    helper.initializeServerAutomations();

    ["attacker-one", "attacker-two"].forEach((instanceId) => {
      helper.fetchGoveeDevices({
        instanceId,
        homebridgeAutoOffEnabled: true,
        homebridgeAutoOffDeviceName: "Attacker Outlet",
        homebridgeAutoOffThresholdWatts: 1000,
        homebridgeAutoOffArmWatts: 1001,
        homebridgeAutoOffBelowDuration: 1,
        homebridgeAutoOffPollInterval: 1,
        presenceDisplayControlEnabled: true,
        presenceDisplaySensorName: "Attacker Sensor",
        presenceDisplayOffDelay: 1,
        presenceDisplayPollInterval: 1,
        presenceDisplayOutput: "ATTACKER-1"
      });
    });

    assert.deepEqual(Object.keys(helper.homebridgeAutoOffMonitors), []);
    assert.deepEqual(Object.keys(helper.presenceDisplayMonitors), []);
    assert.equal(outletWrites, 0);
    assert.equal(displayWrites, 0);
  } finally {
    clearAutomationMonitors();
    restoreEnvironment();
    helper.fetchCloudDevicesSegmented = originalFetch;
    helper.withHomebridgePower = originalWithPower;
    helper.sendDevicesData = originalSend;
    helper.setHomebridgeOutletState = originalSetOutlet;
    helper.setDisplayPower = originalSetDisplay;
    if (previousApiKey === undefined) {
      delete process.env.GOVEE_API_KEY;
    } else {
      process.env.GOVEE_API_KEY = previousApiKey;
    }
  }
});

test("server automation policy is authoritative and uses singleton monitors", () => {
  const restoreEnvironment = replaceServerAutomationEnvironment({
    HOMEBRIDGE_URL: "https://trusted.example:8581",
    HOMEBRIDGE_USERNAME: "server-user",
    HOMEBRIDGE_PASSWORD: "server-password",
    HOMEBRIDGE_AUTO_OFF_ENABLED: "true",
    HOMEBRIDGE_AUTO_OFF_DEVICE_NAME: "Authorized Outlet",
    HOMEBRIDGE_AUTO_OFF_THRESHOLD_WATTS: "4.5",
    HOMEBRIDGE_AUTO_OFF_ARM_WATTS: "22",
    HOMEBRIDGE_AUTO_OFF_BELOW_DURATION_MS: "240000",
    HOMEBRIDGE_AUTO_OFF_POLL_INTERVAL_MS: "45000",
    PRESENCE_DISPLAY_CONTROL_ENABLED: "true",
    PRESENCE_DISPLAY_SENSOR_NAME: "Authorized Sensor",
    PRESENCE_DISPLAY_OFF_DELAY_MS: "180000",
    PRESENCE_DISPLAY_POLL_INTERVAL_MS: "20000",
    PRESENCE_DISPLAY_OUTPUT: "DP-1"
  });
  const previousApiKey = process.env.GOVEE_API_KEY;
  const originalSendError = helper.sendDevicesError;

  delete process.env.GOVEE_API_KEY;
  helper.sendDevicesError = () => {};

  try {
    clearAutomationMonitors();
    helper.initializeServerAutomations();
    ["attacker-one", "attacker-two"].forEach((instanceId) => {
      helper.fetchGoveeDevices({
        instanceId,
        homebridgeAutoOffEnabled: true,
        homebridgeAutoOffDeviceName: "Retargeted Outlet",
        homebridgeAutoOffThresholdWatts: 999,
        homebridgeAutoOffArmWatts: 1000,
        homebridgeAutoOffBelowDuration: 1,
        homebridgeAutoOffPollInterval: 1,
        presenceDisplayControlEnabled: true,
        presenceDisplaySensorName: "Retargeted Sensor",
        presenceDisplayOffDelay: 1,
        presenceDisplayPollInterval: 1,
        presenceDisplayOutput: "RETARGETED-1"
      });
    });

    assert.deepEqual(Object.keys(helper.homebridgeAutoOffMonitors), ["__server_homebridge_auto_off"]);
    assert.deepEqual(Object.keys(helper.presenceDisplayMonitors), ["__server_presence_display"]);
    assert.deepEqual(
      {
        deviceName: helper.homebridgeAutoOffMonitors.__server_homebridge_auto_off.config.deviceName,
        thresholdWatts: helper.homebridgeAutoOffMonitors.__server_homebridge_auto_off.config.thresholdWatts,
        armWatts: helper.homebridgeAutoOffMonitors.__server_homebridge_auto_off.config.armWatts,
        belowDuration: helper.homebridgeAutoOffMonitors.__server_homebridge_auto_off.config.belowDuration,
        pollInterval: helper.homebridgeAutoOffMonitors.__server_homebridge_auto_off.config.pollInterval
      },
      {
        deviceName: "Authorized Outlet",
        thresholdWatts: 4.5,
        armWatts: 22,
        belowDuration: 240000,
        pollInterval: 45000
      }
    );
    assert.deepEqual(
      {
        sensorName: helper.presenceDisplayMonitors.__server_presence_display.config.sensorName,
        offDelay: helper.presenceDisplayMonitors.__server_presence_display.config.offDelay,
        pollInterval: helper.presenceDisplayMonitors.__server_presence_display.config.pollInterval,
        output: helper.presenceDisplayMonitors.__server_presence_display.config.output
      },
      {
        sensorName: "Authorized Sensor",
        offDelay: 180000,
        pollInterval: 20000,
        output: "DP-1"
      }
    );

    helper.initializeServerAutomations();
    assert.equal(Object.keys(helper.homebridgeAutoOffMonitors).length, 1);
    assert.equal(Object.keys(helper.presenceDisplayMonitors).length, 1);
  } finally {
    clearAutomationMonitors();
    restoreEnvironment();
    helper.sendDevicesError = originalSendError;
    if (previousApiKey === undefined) {
      delete process.env.GOVEE_API_KEY;
    } else {
      process.env.GOVEE_API_KEY = previousApiKey;
    }
  }
});

test("incomplete or invalid enabled server automation policy fails closed", () => {
  const restoreEnvironment = replaceServerAutomationEnvironment({
    HOMEBRIDGE_URL: "https://trusted.example:8581",
    HOMEBRIDGE_USERNAME: "server-user",
    HOMEBRIDGE_PASSWORD: "server-password",
    HOMEBRIDGE_AUTO_OFF_ENABLED: "true",
    HOMEBRIDGE_AUTO_OFF_DEVICE_NAME: "Authorized Outlet",
    HOMEBRIDGE_AUTO_OFF_THRESHOLD_WATTS: "5",
    HOMEBRIDGE_AUTO_OFF_ARM_WATTS: "4",
    HOMEBRIDGE_AUTO_OFF_BELOW_DURATION_MS: "300000",
    HOMEBRIDGE_AUTO_OFF_POLL_INTERVAL_MS: "30000",
    PRESENCE_DISPLAY_CONTROL_ENABLED: "true",
    PRESENCE_DISPLAY_SENSOR_NAME: "Authorized Sensor",
    PRESENCE_DISPLAY_OFF_DELAY_MS: "300000",
    PRESENCE_DISPLAY_POLL_INTERVAL_MS: "15000",
    PRESENCE_DISPLAY_OUTPUT: "../../unexpected"
  });
  const originalConsoleError = console.error;
  const errors = [];

  console.error = (...args) => errors.push(args.join(" "));

  try {
    clearAutomationMonitors();
    helper.initializeServerAutomations();

    assert.deepEqual(Object.keys(helper.homebridgeAutoOffMonitors), []);
    assert.deepEqual(Object.keys(helper.presenceDisplayMonitors), []);
    assert.ok(errors.some((message) => message.includes("ARM_WATTS")));
    assert.ok(errors.some((message) => message.includes("PRESENCE_DISPLAY_OUTPUT")));
  } finally {
    console.error = originalConsoleError;
    clearAutomationMonitors();
    restoreEnvironment();
  }
});

test("Homebridge characteristic writer sends outlet off command", async () => {
  const originalRequest = https.request;
  let requestOptions;
  let requestBody;

  https.request = (options, responseCallback) => {
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
        "https://homebridge.local:8581",
        "test-token",
        true,
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
    https.request = originalRequest;
  }
});

test("Govee API key is accepted only from the server environment", () => {
  const previousApiKey = process.env.GOVEE_API_KEY;
  const originalFetch = helper.fetchCloudDevicesSegmented;
  const originalSend = helper.sendDevicesData;
  const originalSendError = helper.sendDevicesError;
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

    delete process.env.GOVEE_API_KEY;
    let errorMessage;
    helper.sendDevicesError = (message) => {
      errorMessage = message;
    };
    helper.fetchGoveeDevices({ apiKey: "renderer-key" });
    assert.match(errorMessage, /API key is required/);
  } finally {
    helper.fetchCloudDevicesSegmented = originalFetch;
    helper.sendDevicesData = originalSend;
    helper.sendDevicesError = originalSendError;
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