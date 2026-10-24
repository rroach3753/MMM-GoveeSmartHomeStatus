const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

class Display {
  constructor(config, environment = process.env, execute = execFile) {
    this.environment = { ...environment };
    this.execute = execute;
    this.children = new Set();
    this.closed = false;
    const uid = process.getuid?.();
    this.environment.XDG_RUNTIME_DIR ||= uid === undefined ? "" : `/run/user/${uid}`;
    const waylandSocket = path.join(this.environment.XDG_RUNTIME_DIR, "wayland-0");
    this.backend = config.backend;
    if (this.backend === "auto") {
      if (environment.WAYLAND_DISPLAY || environment.XDG_SESSION_TYPE === "wayland" ||
          fs.existsSync(waylandSocket)) this.backend = "wayland";
      else if (environment.DISPLAY) this.backend = "x11";
      else throw new Error("Cannot detect desktop session; set PRESENCE_DISPLAY_BACKEND and desktop environment variables");
    }
    this.output = config.output;
    if (this.backend === "wayland") {
      if (!this.output) throw new Error("PRESENCE_DISPLAY_OUTPUT is required for Wayland; inspect connectors with wlr-randr");
      this.environment.WAYLAND_DISPLAY ||= "wayland-0";
    } else if (!this.environment.DISPLAY) {
      throw new Error("DISPLAY is required for the X11 backend");
    }
  }

  run(command, args) {
    if (this.closed) return Promise.reject(new Error("Presence display controller stopped"));
    return new Promise((resolve, reject) => {
      const child = this.execute(command, args, {
        env: this.environment, timeout: 10000, maxBuffer: 256 * 1024, encoding: "utf8"
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${command} failed: ${stderr?.trim() || error.message}`));
        } else {
          resolve(stdout);
        }
      });
      this.children.add(child);
      child.once("close", () => this.children.delete(child));
    });
  }

  async isOn() {
    if (this.backend === "wayland") {
      const result = await this.run("/usr/bin/wlr-randr", []);
      let selected = false;
      for (const line of result.split("\n")) {
        if (/^\S/.test(line)) selected = line.split(/\s/)[0] === this.output;
        if (selected && /^\s+Enabled: (yes|no)\s*$/.test(line)) return line.trim() === "Enabled: yes";
      }
      throw new Error(`Wayland output ${this.output} not found or has no readable state`);
    }
    const result = await this.run("/usr/bin/xset", ["q"]);
    if (!/DPMS is Enabled/.test(result)) {
      throw new Error("X11 DPMS is unavailable or disabled; enable DPMS with xset +dpms");
    }
    const state = result.match(/Monitor is (On|Off|Standby|Suspend)/);
    if (!state) throw new Error("Cannot read X11 monitor power state");
    return state[1] === "On";
  }

  async setPower(enabled) {
    if (this.backend === "wayland") {
      await this.run("/usr/bin/wlr-randr", ["--output", this.output, enabled ? "--on" : "--off"]);
    } else {
      await this.run("/usr/bin/xset", ["dpms", "force", enabled ? "on" : "off"]);
    }
    const actual = await this.isOn();
    if (actual !== enabled) throw new Error(`Display did not reach the requested ${enabled ? "on" : "off"} state`);
  }

  close() {
    this.closed = true;
    for (const child of this.children) child.kill();
  }
}

module.exports = { Display };
