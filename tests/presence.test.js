const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Display } = require("../lib/display");
const { PresenceController, readSensors, resolvePresenceDisplayPolicy } = require("../lib/presence");

const homebridgeConfig = {
  url: "https://homebridge.local:8581",
  username: "user",
  password: "password",
  error: null
};

test("presence display policy is opt-in, server-only, and validates names and display settings", () => {
  assert.deepEqual(resolvePresenceDisplayPolicy({}, homebridgeConfig, true), { config: null, error: null });
  const configured = resolvePresenceDisplayPolicy({
    PRESENCE_DISPLAY_ENABLED: "true",
    PRESENCE_DISPLAY_SENSOR_NAMES: '[" Hallway Sensor "]',
    PRESENCE_DISPLAY_BACKEND: "wayland",
    PRESENCE_DISPLAY_OUTPUT: "HDMI-A-1"
  }, homebridgeConfig, true);
  assert.equal(configured.error, null);
  assert.deepEqual(configured.config.sensors, ["Hallway Sensor"]);
  assert.equal(configured.config.offDelay, 300000);
  assert.equal(configured.config.pollInterval, 15000);
  assert.equal(configured.config.output, "HDMI-A-1");

  for (const env of [
    { PRESENCE_DISPLAY_ENABLED: "sometimes" },
    { PRESENCE_DISPLAY_ENABLED: "true", PRESENCE_DISPLAY_SENSOR_NAMES: "not-json" },
    { PRESENCE_DISPLAY_ENABLED: "true", PRESENCE_DISPLAY_SENSOR_NAMES: "[]" },
    { PRESENCE_DISPLAY_ENABLED: "true", PRESENCE_DISPLAY_SENSOR_NAMES: '["Hall"," hall "]' },
    { PRESENCE_DISPLAY_ENABLED: "true", PRESENCE_DISPLAY_SENSOR_NAMES: '["Hall"]', PRESENCE_DISPLAY_BACKEND: "other" },
    { PRESENCE_DISPLAY_ENABLED: "true", PRESENCE_DISPLAY_SENSOR_NAMES: '["Hall"]', PRESENCE_DISPLAY_OFF_DELAY_MS: "999" },
    { PRESENCE_DISPLAY_ENABLED: "true", PRESENCE_DISPLAY_SENSOR_NAMES: '["Hall"]', PRESENCE_DISPLAY_OUTPUT: "../output" }
  ]) {
    assert.ok(resolvePresenceDisplayPolicy(env, homebridgeConfig, true).error);
  }
  assert.match(resolvePresenceDisplayPolicy({
    PRESENCE_DISPLAY_ENABLED: "true",
    PRESENCE_DISPLAY_SENSOR_NAMES: '["Hall"]'
  }, { ...homebridgeConfig, error: "invalid URL" }, true).error, /invalid URL/);
  assert.match(resolvePresenceDisplayPolicy({
    PRESENCE_DISPLAY_ENABLED: "true",
    PRESENCE_DISPLAY_SENSOR_NAMES: '["Hall"]'
  }, { ...homebridgeConfig, password: "" }, true).error, /HOMEBRIDGE_PASSWORD is required/);
});

test("Homebridge sensor readings match exact names and fail closed when missing or ambiguous", () => {
  const occupancyUuid = "00000071-0000-1000-8000-0026BB765291";
  const motionUuid = "00000022-0000-1000-8000-0026BB765291";
  const accessories = [
    {
      accessoryInformation: { Name: "Hallway" },
      serviceCharacteristics: [
        { uuid: occupancyUuid, serviceName: "Hallway Occupancy", value: 1, status: 0 },
        { uuid: motionUuid, serviceName: "Hallway Motion", value: false, status: 0 }
      ]
    },
    {
      accessoryInformation: { Name: "Second Sensor" },
      serviceCharacteristics: [
        { uuid: occupancyUuid, serviceName: "Second Sensor", value: "true", status: 0 }
      ]
    }
  ];
  assert.deepEqual(readSensors(accessories, ["Hallway Occupancy", "Second Sensor", "Missing"]), [
    { name: "Hallway Occupancy", value: true, error: null },
    { name: "Second Sensor", value: true, error: null },
    { name: "Missing", value: null, error: "not found" }
  ]);
  assert.equal(readSensors(accessories, ["Hallway"])[0].error, "ambiguous name; use a unique service name");
  assert.equal(readSensors([{
    accessoryInformation: { Name: "Unreadable" },
    serviceCharacteristics: [{ uuid: occupancyUuid, value: true, status: 1 }]
  }], ["Unreadable"])[0].error, "unreadable value");
  assert.throws(() => readSensors({}, ["Hall"]), /must be an array/);
});

function controllerHarness() {
  let now = 0;
  let readings = [{ name: "sensor", value: false, error: null }];
  let on = true;
  let readError = null;
  const writes = [];
  const reports = [];
  const client = {
    read: async () => {
      if (readError) throw readError;
      return readings;
    },
    close() {}
  };
  const display = {
    isOn: async () => on,
    setPower: async (enabled) => {
      writes.push(enabled);
      on = enabled;
    },
    close() {}
  };
  const controller = new PresenceController({ offDelay: 300000, pollInterval: 15000 },
    client, display, (status) => reports.push(status), () => now);
  return {
    controller, writes, reports,
    time(value) { now = value; },
    readings(value) { readings = value; },
    readError(value) { readError = value; },
    async poll() {
      clearTimeout(controller.timer);
      await controller.poll();
      clearTimeout(controller.timer);
    }
  };
}

test("display turns off only after continuous all-clear and wakes on any presence", async () => {
  const harness = controllerHarness();
  try {
    await harness.poll();
    for (let time = 15000; time < 300000; time += 15000) {
      harness.time(time);
      await harness.poll();
    }
    harness.time(299999);
    await harness.poll();
    assert.deepEqual(harness.writes, []);
    harness.time(300000);
    await harness.poll();
    assert.deepEqual(harness.writes, [false]);
    harness.readings([{ name: "sensor", value: true, error: null }]);
    harness.time(315000);
    await harness.poll();
    assert.deepEqual(harness.writes, [false, true]);
  } finally {
    harness.controller.stop();
  }
});

test("unavailable sensors and Homebridge failures prevent shutoff and reset the timer", async () => {
  const harness = controllerHarness();
  try {
    await harness.poll();
    harness.time(15000);
    harness.readings([{ name: "sensor", value: null, error: "not found" }]);
    await harness.poll();
    assert.equal(harness.controller.absentSince, null);
    assert.equal(harness.reports.at(-1).level, "warn");
    harness.readings([{ name: "sensor", value: false, error: null }]);
    harness.time(30000);
    await harness.poll();
    assert.equal(harness.controller.absentSince, 30000);
    harness.readError(new Error("Homebridge offline"));
    harness.time(45000);
    await harness.poll();
    assert.equal(harness.controller.absentSince, null);
    assert.equal(harness.reports.at(-1).level, "error");
    assert.deepEqual(harness.writes, []);
  } finally {
    harness.controller.stop();
  }
});

test("Wayland and X11 commands use fixed arguments and verify power changes", async () => {
  for (const backend of ["wayland", "x11"]) {
    let on = true;
    const calls = [];
    const execute = (command, args, options, callback) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => {
        if (args.includes("--on") || args.includes("on")) on = true;
        if (args.includes("--off") || args.includes("off")) on = false;
        const stdout = backend === "wayland"
          ? `HDMI-A-1 "Monitor"\n  Enabled: ${on ? "yes" : "no"}\n`
          : `DPMS is Enabled\n  Monitor is ${on ? "On" : "Off"}\n`;
        callback(null, stdout, "");
        child.emit("close");
      });
      return child;
    };
    const display = new Display({ backend, output: "HDMI-A-1" }, { DISPLAY: ":0" }, execute);
    assert.equal(await display.isOn(), true);
    await display.setPower(false);
    assert.equal(await display.isOn(), false);
    assert.equal(calls[0].command, backend === "wayland" ? "/usr/bin/wlr-randr" : "/usr/bin/xset");
    assert.equal(calls[0].options.shell, undefined);
    display.close();
  }
});
