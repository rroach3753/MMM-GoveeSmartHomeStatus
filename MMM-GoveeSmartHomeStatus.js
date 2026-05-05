/* global Module */

Module.register("MMM-GoveeSmartHomeStatus", {
  defaults: {
    title: "Govee Devices",
    apiKey: "",
    refreshInterval: 480000,
    showOnlineOnly: false,
    showPower: true,
    showTemperature: true,
    showHumidity: true,
    showLightsSummary: true,
    showRoomSummary: true,
    roomSummaryLightsOnly: false,
    lightDetectionKeywords: ["light", "lamp", "bulb", "strip", "led"],
    hideAppliances: true,
    hiddenApplianceKeywords: ["ice maker", "icemaker", "refrigerator", "fridge"],
    roomNameDelimiter: " - ",
    fullWidthBottomBar: false,
    compactCards: false,
    maxCompactCards: 12,
    emptyMessage: "No devices available.",
    loadingMessage: "Loading Govee devices...",
    noApiKeyMessage: "API key not configured.",
    errorMessage: "Error fetching Govee device data."
  },

  start: function () {
    this.dataState = {
      devices: [],
      fetchedAt: null,
      error: null,
      loading: true
    };

    this.configRetryCount = 0;
    this.maxConfigRetries = 3;
    this.requestBackendData();
  },

  requestBackendData: function () {
    var self = this;

    this.sendSocketNotification("GOVEE_DEVICES_REQUEST", {
      apiKey: this.config.apiKey
    });

    if (this.configRetryTimer) {
      clearTimeout(this.configRetryTimer);
    }

    this.configRetryTimer = setTimeout(function () {
      if (self.dataState.loading && self.configRetryCount < self.maxConfigRetries) {
        self.configRetryCount += 1;
        self.requestBackendData();
      } else if (self.dataState.loading) {
        self.dataState.loading = false;
        self.dataState.error = "Unable to fetch Govee device data. Check API key and connection.";
        self.updateDom(300);
      }
    }, 5000);
  },

  socketNotificationReceived: function (notification, payload) {
    var self = this;

    if (notification === "GOVEE_DEVICES_DATA") {
      this.dataState.loading = false;
      this.dataState.error = null;
      this.dataState.devices = payload.devices || [];
      this.dataState.fetchedAt = new Date();
      this.configRetryCount = 0; // Reset retry count on success

      if (this.configRetryTimer) {
        clearTimeout(this.configRetryTimer);
      }

      this.updateDom(300);

      if (this.config.refreshInterval > 0) {
        if (this.refreshTimer) {
          clearTimeout(this.refreshTimer);
        }

        this.refreshTimer = setTimeout(function () {
          self.requestBackendData();
        }, this.config.refreshInterval);
      }
    } else if (notification === "GOVEE_DEVICES_ERROR") {
      this.dataState.loading = false;
      this.dataState.error = payload.error || this.config.errorMessage;
      this.dataState.devices = [];

      if (this.configRetryTimer) {
        clearTimeout(this.configRetryTimer);
      }

      // Set up automatic retry after error with exponential backoff
      var retryDelay = Math.min(5000 * Math.pow(1.5, this.configRetryCount), 30000);
      console.warn("[MMM-GoveeSmartHomeStatus] Error occurred. Retrying in " + (retryDelay / 1000) + " seconds...");
      
      this.configRetryTimer = setTimeout(function () {
        if (self.configRetryCount < self.maxConfigRetries) {
          self.configRetryCount += 1;
          self.dataState.loading = true;
          self.requestBackendData();
        }
      }, retryDelay);

      this.updateDom(300);
    }
  },

  getStyles: function () {
    return ["MMM-GoveeSmartHomeStatus.css"];
  },

  getDom: function () {
    var wrapper = document.createElement("div");
    wrapper.className = "mmm-govee-smartHome";

    if (this.config.fullWidthBottomBar) {
      wrapper.classList.add("full-width-bottom-bar");
    }

    if (this.config.compactCards) {
      wrapper.classList.add("compact-cards-enabled");
    }

    // Title
    if (this.config.title) {
      var titleDiv = document.createElement("div");
      titleDiv.className = "title";
      titleDiv.textContent = this.config.title;
      wrapper.appendChild(titleDiv);
    }

    // Error state
    if (this.dataState.error) {
      var errorDiv = document.createElement("div");
      errorDiv.className = "error";
      errorDiv.textContent = this.dataState.error;
      wrapper.appendChild(errorDiv);
      return wrapper;
    }

    // No API key
    if (!this.config.apiKey) {
      var noKeyDiv = document.createElement("div");
      noKeyDiv.className = "message";
      noKeyDiv.textContent = this.config.noApiKeyMessage;
      wrapper.appendChild(noKeyDiv);
      return wrapper;
    }

    // Loading state
    if (this.dataState.loading) {
      var loadingDiv = document.createElement("div");
      loadingDiv.className = "message";
      loadingDiv.textContent = this.config.loadingMessage;
      wrapper.appendChild(loadingDiv);
      return wrapper;
    }

    var filteredDevices = this.getFilteredDevices(this.dataState.devices);

    // Empty state
    if (filteredDevices.length === 0) {
      var emptyDiv = document.createElement("div");
      emptyDiv.className = "message";
      emptyDiv.textContent = this.config.emptyMessage;
      wrapper.appendChild(emptyDiv);
      return wrapper;
    }

    // Device list
    var container = document.createElement("div");
    container.className = "govee-container";

    this.appendSummaries(container, filteredDevices);

    // Render device list (full or compact)
    if (this.config.compactCards) {
      var compactList = this.createCompactCardList(filteredDevices);
      container.appendChild(compactList);
    } else {
      var deviceList = document.createElement("div");
      deviceList.className = "device-list";

      filteredDevices.forEach(function (device) {
        var deviceItem = document.createElement("div");
        deviceItem.className = "device-item";

        if (!device.online) {
          deviceItem.classList.add("offline");
        }

        // Device name
        var nameDiv = document.createElement("div");
        nameDiv.className = "device-name";
        nameDiv.textContent = device.deviceName || "Unknown Device";

        // Device status
        var statusDiv = document.createElement("div");
        statusDiv.className = "device-status";

        // Online/Offline badge
        var badge = document.createElement("span");
        badge.className = "status-badge";
        if (device.online) {
          badge.classList.add("online");
          badge.textContent = "ONLINE";
        } else {
          badge.classList.add("offline");
          badge.textContent = "OFFLINE";
        }
        statusDiv.appendChild(badge);

        if (this.config.showPower && typeof device.powerState !== "undefined") {
          var powerSpan = document.createElement("span");
          powerSpan.className = "device-detail";
          powerSpan.textContent = device.powerState ? "On" : "Off";
          statusDiv.appendChild(document.createElement("br"));
          statusDiv.appendChild(powerSpan);
        }

        if (this.config.showTemperature && typeof device.temperature !== "undefined") {
          var temperatureSpan = document.createElement("span");
          temperatureSpan.className = "device-detail";
          temperatureSpan.textContent = "Temp: " + device.temperature;
          statusDiv.appendChild(document.createElement("br"));
          statusDiv.appendChild(temperatureSpan);
        }

        if (this.config.showHumidity && typeof device.humidity !== "undefined") {
          var humiditySpan = document.createElement("span");
          humiditySpan.className = "device-detail";
          humiditySpan.textContent = "Humidity: " + device.humidity + "%";
          statusDiv.appendChild(document.createElement("br"));
          statusDiv.appendChild(humiditySpan);
        }

        deviceItem.appendChild(nameDiv);
        deviceItem.appendChild(statusDiv);
        deviceList.appendChild(deviceItem);
      }.bind(this));

      container.appendChild(deviceList);
    }
    wrapper.appendChild(container);

    return wrapper;
  },

  createCompactCardList: function (devices) {
    var maxCards = Number(this.config.maxCompactCards) || 12;
    var devicesToShow = devices.slice(0, maxCards);

    var wrapper = document.createElement("div");
    wrapper.className = "compact-card-list";

    if (this.config.fullWidthBottomBar) {
      wrapper.classList.add("bottom-bar-compact");

      // Keep bottom bar cards to a maximum of two rows and distribute
      // columns evenly so cards expand to available width.
      var columnCount = Math.max(1, Math.ceil(devicesToShow.length / 2));
      wrapper.classList.add("rows-2");
      wrapper.style.gridTemplateColumns = "repeat(" + columnCount + ", minmax(0, 1fr))";
      wrapper.style.gridTemplateRows = "repeat(2, minmax(30px, auto))";
    }

    devicesToShow.forEach(function (device) {
      var card = document.createElement("div");
      card.className = "compact-card";

      if (!device.online) {
        card.classList.add("offline");
      }

      if (device.powerState === true) {
        card.classList.add("on");
      }

      // Card content
      var nameDiv = document.createElement("div");
      nameDiv.className = "compact-card-name";
      nameDiv.textContent = device.deviceName || "Unknown";
      card.appendChild(nameDiv);

      if (this.config.showPower && typeof device.powerState !== "undefined") {
        var powerDiv = document.createElement("div");
        powerDiv.className = "compact-card-power";
        powerDiv.textContent = device.powerState ? "ON" : "OFF";
        card.appendChild(powerDiv);
      }

      wrapper.appendChild(card);
    }.bind(this));

    return wrapper;
  },

  getFilteredDevices: function (devices) {
    return devices.filter(function (device) {
      if (this.config.showOnlineOnly && device.online === false) {
        return false;
      }

      if (this.config.hideAppliances && this.isApplianceDevice(device)) {
        return false;
      }
      return true;
    }.bind(this));
  },

  isApplianceDevice: function (device) {
    var keywords = Array.isArray(this.config.hiddenApplianceKeywords) ? this.config.hiddenApplianceKeywords : [];
    var haystack = [device.deviceName, device.deviceType, device.model].join(" ").toLowerCase();

    return keywords.some(function (keyword) {
      return haystack.indexOf(String(keyword || "").toLowerCase()) !== -1;
    });
  },

  isLightDevice: function (device) {
    var haystack = [device.deviceName, device.deviceType, device.model].join(" ").toLowerCase();
    var lightKeywords = Array.isArray(this.config.lightDetectionKeywords)
      ? this.config.lightDetectionKeywords
      : ["light", "lamp", "bulb", "strip", "led"];

    return lightKeywords.some(function (keyword) {
      return haystack.indexOf(String(keyword || "").toLowerCase()) !== -1;
    });
  },

  inferRoomName: function (device) {
    if (device.roomName) {
      return String(device.roomName);
    }

    var deviceName = String(device.deviceName || "").trim();
    if (!deviceName) {
      return "Unassigned";
    }

    var delimiter = String(this.config.roomNameDelimiter || " - ");
    var splitIndex = deviceName.indexOf(delimiter);
    if (splitIndex > 0) {
      return deviceName.slice(0, splitIndex).trim();
    }

    return "Unassigned";
  },

  appendSummaries: function (container, devices) {
    var summaryWrap = document.createElement("div");
    summaryWrap.className = "summary-wrap";
    var hasSummary = false;

    if (this.config.showLightsSummary) {
      var lightsSummary = this.buildLightsSummary(devices);
      summaryWrap.appendChild(lightsSummary);
      hasSummary = true;
    }

    if (this.config.showRoomSummary) {
      var roomSummary = this.buildRoomSummary(devices);
      summaryWrap.appendChild(roomSummary);
      hasSummary = true;
    }

    if (hasSummary) {
      container.appendChild(summaryWrap);
    }
  },

  buildLightsSummary: function (devices) {
    var lights = devices.filter(function (device) {
      return this.isLightDevice(device);
    }.bind(this));

    var lightsOn = lights.filter(function (device) {
      return device.powerState === true;
    }).length;

    var summary = document.createElement("div");
    summary.className = "summary-section lights-summary";

    var label = document.createElement("div");
    label.className = "summary-label";
    label.textContent = "Lights";

    var value = document.createElement("div");
    value.className = "summary-value";
    value.textContent = lightsOn + " on / " + (lights.length - lightsOn) + " off";

    summary.appendChild(label);
    summary.appendChild(value);
    return summary;
  },

  buildRoomSummary: function (devices) {
    var roomDevices = devices;
    if (this.config.roomSummaryLightsOnly) {
      roomDevices = devices.filter(function (device) {
        return this.isLightDevice(device);
      }.bind(this));
    }

    var roomCounts = {};

    roomDevices.forEach(function (device) {
      var room = this.inferRoomName(device);
      if (!roomCounts[room]) {
        roomCounts[room] = { on: 0, total: 0 };
      }

      roomCounts[room].total += 1;
      if (device.powerState === true) {
        roomCounts[room].on += 1;
      }
    }.bind(this));

    var summary = document.createElement("div");
    summary.className = "summary-section room-summary";

    var label = document.createElement("div");
    label.className = "summary-label";
    label.textContent = this.config.roomSummaryLightsOnly ? "By room (lights)" : "By room";
    summary.appendChild(label);

    var grid = document.createElement("div");
    grid.className = "room-summary-grid";

    var rooms = Object.keys(roomCounts).sort();
    if (rooms.length === 0) {
      var emptyItem = document.createElement("div");
      emptyItem.className = "room-summary-item";
      emptyItem.textContent = "No matching devices";
      grid.appendChild(emptyItem);
    } else {
      rooms.forEach(function (room) {
        var item = document.createElement("div");
        item.className = "room-summary-item";
        if (roomCounts[room].on > 0) {
          item.classList.add("on");
        } else {
          item.classList.add("off");
        }
        item.textContent = room + ": " + roomCounts[room].on + "/" + roomCounts[room].total + " on";
        grid.appendChild(item);
      });
    }

    summary.appendChild(grid);
    return summary;
  }
});
