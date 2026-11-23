const SENSOR_UUIDS = new Set([
  "00000071-0000-1000-8000-0026BB765291",
  "00000022-0000-1000-8000-0026BB765291"
]);

function sensorValue(value) {
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return null;
}

function readSensors(accessories, names) {
  if (!Array.isArray(accessories)) throw new Error("Homebridge accessories response must be an array");
  const matches = new Map(names.map((name) => [name.toLowerCase(), []]));
  for (const accessory of accessories) {
    if (!accessory || !Array.isArray(accessory.serviceCharacteristics)) continue;
    for (const characteristic of accessory.serviceCharacteristics) {
      if (!characteristic || !SENSOR_UUIDS.has(String(characteristic.uuid).toUpperCase())) continue;
      const aliases = new Set([
        accessory.accessoryInformation?.Name,
        accessory.serviceName,
        characteristic.serviceName
      ].filter((name) => typeof name === "string").map((name) => name.trim().toLowerCase()));
      for (const alias of aliases) {
        if (matches.has(alias)) {
          matches.get(alias).push(characteristic.status && characteristic.status !== 0
            ? null : sensorValue(characteristic.value));
        }
      }
    }
  }
  return names.map((name) => {
    const values = matches.get(name.toLowerCase());
    return {
      name,
      value: values.length === 1 ? values[0] : null,
      error: values.length === 0 ? "not found" : values.length > 1
        ? "ambiguous name; use a unique service name" : values[0] === null ? "unreadable value" : null
    };
  });
}

function resolvePresenceDisplayPolicy(env, homebridgeConfig, verifySSL) {
  const enabled = String(env.PRESENCE_DISPLAY_ENABLED || "").trim().toLowerCase();
  if (!enabled || ["0", "false", "no", "off"].includes(enabled)) return { config: null, error: null };
  if (!["1", "true", "yes", "on"].includes(enabled)) {
    return { config: null, error: "PRESENCE_DISPLAY_ENABLED must be true or false." };
  }
  if (homebridgeConfig.error || !homebridgeConfig.url || !homebridgeConfig.username) {
    return {
      config: null,
      error: homebridgeConfig.error || "Homebridge server credentials are required when PRESENCE_DISPLAY_ENABLED=true."
    };
  }
  if (!homebridgeConfig.password) {
    return { config: null, error: "HOMEBRIDGE_PASSWORD is required when PRESENCE_DISPLAY_ENABLED=true." };
  }

  let names;
  try {
    names = JSON.parse(env.PRESENCE_DISPLAY_SENSOR_NAMES || "[]");
  } catch {
    return { config: null, error: "PRESENCE_DISPLAY_SENSOR_NAMES must be a JSON array of sensor names." };
  }
  if (!Array.isArray(names) || names.length === 0 || names.length > 32 ||
      names.some((name) => typeof name !== "string" || !name.trim() || name.length > 256)) {
    return { config: null, error: "PRESENCE_DISPLAY_SENSOR_NAMES must contain 1 through 32 nonempty sensor names." };
  }
  names = names.map((name) => name.trim());
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
    return { config: null, error: "PRESENCE_DISPLAY_SENSOR_NAMES must not contain duplicate names." };
  }

  const backend = String(env.PRESENCE_DISPLAY_BACKEND || "auto").trim().toLowerCase();
  if (!["auto", "wayland", "x11"].includes(backend)) {
    return { config: null, error: "PRESENCE_DISPLAY_BACKEND must be auto, wayland, or x11." };
  }
  const output = String(env.PRESENCE_DISPLAY_OUTPUT || "").trim();
  if (output && !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(output)) {
    return { config: null, error: "PRESENCE_DISPLAY_OUTPUT must be a connector name such as HDMI-A-1." };
  }

  function integerSetting(name, fallback, minimum) {
    const raw = env[name] === undefined ? fallback : env[name];
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= minimum && value <= 2147483647 ? value : null;
  }

  const offDelay = integerSetting("PRESENCE_DISPLAY_OFF_DELAY_MS", 300000, 1000);
  const pollInterval = integerSetting("PRESENCE_DISPLAY_POLL_INTERVAL_MS", 15000, 1000);
  if (offDelay === null) {
    return { config: null, error: "PRESENCE_DISPLAY_OFF_DELAY_MS must be an integer between 1000 and 2147483647." };
  }
  if (pollInterval === null) {
    return { config: null, error: "PRESENCE_DISPLAY_POLL_INTERVAL_MS must be an integer between 1000 and 2147483647." };
  }
  return {
    config: {
      url: homebridgeConfig.url,
      username: homebridgeConfig.username,
      password: homebridgeConfig.password,
      verifySSL,
      sensors: names,
      backend,
      output,
      offDelay,
      pollInterval
    },
    error: null
  };
}

class PresenceController {
  constructor(config, client, display, report, now = Date.now) {
    this.config = config;
    this.client = client;
    this.display = display;
    this.report = report;
    this.now = now;
    this.absentSince = null;
    this.lastReading = null;
    this.timer = null;
    this.stopped = false;
    this.running = false;
  }

  async poll() {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const readings = await this.client.read();
      if (this.stopped) return;
      const now = this.now();
      if (this.lastReading !== null && now - this.lastReading > this.config.pollInterval * 2 + 30000) {
        this.absentSince = null;
      }
      this.lastReading = now;
      const present = readings.some((sensor) => sensor.value === true);
      const unavailable = readings.filter((sensor) => sensor.value === null);
      let desired = null;
      if (present) {
        this.absentSince = null;
        desired = true;
      } else if (unavailable.length) {
        this.absentSince = null;
      } else {
        if (this.absentSince === null) this.absentSince = now;
        if (now - this.absentSince >= this.config.offDelay) desired = false;
      }
      const actual = await this.display.isOn();
      if (this.stopped) return;
      if (desired !== null && desired !== actual) {
        await this.display.setPower(desired);
        if (this.stopped) return;
      }
      const missing = unavailable.map((sensor) => `${sensor.name} (${sensor.error})`).join(", ");
      this.report({
        level: unavailable.length ? "warn" : "info",
        message: `${desired === null ? actual ? "Display on" : "Display off" : desired ? "Display on" : "Display off"}; ` +
          (present ? "presence detected" : unavailable.length ? "absence timer paused" : "all sensors clear") +
          (missing ? `; unavailable: ${missing}` : "")
      });
    } catch (error) {
      this.absentSince = null;
      this.lastReading = null;
      if (!this.stopped) this.report({ level: "error", message: error.message });
    } finally {
      this.running = false;
      if (!this.stopped) {
        this.timer = setTimeout(() => this.poll(), this.config.pollInterval);
        this.timer.unref?.();
      }
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.client.close();
    this.display.close();
  }
}

module.exports = { PresenceController, readSensors, resolvePresenceDisplayPolicy };
