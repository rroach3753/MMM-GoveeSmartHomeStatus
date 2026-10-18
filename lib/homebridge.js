const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");
const { Bonjour } = require("bonjour-service");

const MAX_RESPONSE_BYTES = 1048576;
const HOMEBRIDGE_ON_UUID = "00000025-0000-1000-8000-0026BB765291";
const HOMEBRIDGE_OCCUPANCY_UUID = "00000071-0000-1000-8000-0026BB765291";
const HOMEBRIDGE_CURRENT_CONSUMPTION_UUID = "E863F10D-079E-48FF-8F27-9C2605A29F52";

module.exports = {
  canonicalizeHomebridgeOrigin: function (urlValue) {
    var parsedUrl = new URL(String(urlValue || "").trim());

    if (parsedUrl.protocol !== "https:" ||
        parsedUrl.username || parsedUrl.password ||
        (parsedUrl.pathname && parsedUrl.pathname !== "/") ||
        parsedUrl.search || parsedUrl.hash) {
      throw new Error("Homebridge URLs must be valid HTTPS origins without a path, query, fragment, or credentials.");
    }

    return parsedUrl.origin;
  },

  withHomebridgePower: function (url, username, password, verifySSL, devices, callback, allowDiscovery) {
    var self = this;

    this.fetchHomebridgePowerMap(url, username, password, verifySSL, function (error, powerMap) {
      if (error || !powerMap) {
        if (error) {
          console.error("[MMM-GoveeSmartHomeStatus] Homebridge error:", error.message);
        }
        callback(devices);
        return;
      }

      callback(self.applyHomebridgePower(devices, powerMap));
    }, allowDiscovery);
  },

  fetchHomebridgePowerMap: function (url, username, password, verifySSL, callback, allowDiscovery) {
    var self = this;
    this.withHomebridgeDiscovery(url, allowDiscovery, function (targetUrl, done) {
      self.fetchHomebridgePowerMapAtUrl(targetUrl, username, password, verifySSL, done);
    }, callback);
  },

  fetchHomebridgePowerMapAtUrl: function (url, username, password, verifySSL, callback) {
    var self = this;

    this.withHomebridgeToken(url, username, password, verifySSL, function (error, token) {
      if (error) {
        callback(error, null);
        return;
      }

      self.fetchHomebridgeAccessories(url, token, verifySSL, callback, function (accessories) {
        return self.buildHomebridgeStatusMap(accessories);
      }, username);
    });
  },

  fetchHomebridgeOutletMap: function (url, username, password, verifySSL, callback, allowDiscovery) {
    this.fetchHomebridgeMap(url, username, password, verifySSL, callback, allowDiscovery, this.buildHomebridgeOutletMap);
  },

  fetchHomebridgeOccupancyMap: function (url, username, password, verifySSL, callback, allowDiscovery) {
    this.fetchHomebridgeMap(url, username, password, verifySSL, callback, allowDiscovery, this.buildHomebridgeOccupancyMap);
  },

  fetchHomebridgeMap: function (url, username, password, verifySSL, callback, allowDiscovery, mapper) {
    var self = this;
    this.withHomebridgeDiscovery(url, allowDiscovery, function (targetUrl, done) {
      self.withHomebridgeToken(targetUrl, username, password, verifySSL, function (tokenError, token) {
        if (tokenError) {
          done(tokenError, null);
          return;
        }

        self.fetchHomebridgeAccessories(targetUrl, token, verifySSL, done, function (accessories) {
          return mapper.call(self, accessories);
        }, username);
      });
    }, callback);
  },

  withHomebridgeDiscovery: function (url, allowDiscovery, fetchAtUrl, callback) {
    var self = this;
    var fallbacks = this.homebridgeFallbackUrls || (this.homebridgeFallbackUrls = {});
    var fallbackUrl = allowDiscovery === false ? null : fallbacks[url];
    if (fallbackUrl) {
      fetchAtUrl(fallbackUrl, callback);
      return;
    }

    fetchAtUrl(url, function (error, result) {
      if (self.stopped || self.homebridgeFallbackUrls !== fallbacks) return;
      if (!self.isHomebridgeDnsError(error) || allowDiscovery === false) {
        callback(error, result);
        return;
      }

      self.discoverHomebridgeUrl(url, function (discoveryError, discoveredUrl) {
        if (self.stopped || self.homebridgeFallbackUrls !== fallbacks) return;
        if (discoveryError || !discoveredUrl) {
          callback(error, null);
          return;
        }

        fallbacks[url] = discoveredUrl;
        console.warn("[MMM-GoveeSmartHomeStatus] Homebridge hostname could not resolve; using discovered endpoint " + discoveredUrl);
        fetchAtUrl(discoveredUrl, callback);
      });
    });
  },

  withHomebridgeToken: function (url, username, password, verifySSL, callback) {
    var self = this;
    var now = Date.now();
    var cacheKey;
    var cachedToken;

    try {
      cacheKey = this.getHomebridgeTokenCacheKey(url, username);
    } catch (error) {
      callback(error, null);
      return;
    }

    if (!(this.homebridgeTokenCache instanceof Map)) {
      this.homebridgeTokenCache = new Map();
    }

    cachedToken = this.homebridgeTokenCache.get(cacheKey);
    if (cachedToken && cachedToken.token && now < cachedToken.expiresAt) {
      callback(null, cachedToken.token);
      return;
    }

    var tokenCache = this.homebridgeTokenCache;
    this.authenticateHomebridge(url, username, password, verifySSL, function (error, token, expiresAt) {
      if (self.stopped || self.homebridgeTokenCache !== tokenCache) return;
      if (error) {
        callback(error, null);
        return;
      }

      tokenCache.set(cacheKey, {
        token: token,
        expiresAt: expiresAt
      });
      callback(null, token);
    });
  },

  getHomebridgeTokenCacheKey: function (url, username) {
    return JSON.stringify([
      this.canonicalizeHomebridgeOrigin(url),
      String(username || "")
    ]);
  },

  invalidateHomebridgeToken: function (url, username, token) {
    var cacheKey;
    var cachedToken;

    if (!(this.homebridgeTokenCache instanceof Map)) {
      return;
    }

    cacheKey = this.getHomebridgeTokenCacheKey(url, username);
    cachedToken = this.homebridgeTokenCache.get(cacheKey);
    if (!token || (cachedToken && cachedToken.token === token)) {
      this.homebridgeTokenCache.delete(cacheKey);
    }
  },

  isHomebridgeDnsError: function (error) {
    var message = error && error.message ? error.message : "";

    return !!error && (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN" || /\b(?:ENOTFOUND|EAI_AGAIN)\b/.test(message));
  },

  discoverHomebridgeUrl: function (configuredUrl, callback) {
    var self = this;
    var bonjour = new Bonjour();
    var browser;
    var isSettled = false;
    var timeout;
    var cancel = function () { finish(null, null, true); };
    this.trackCleanup(cancel);

    function finish(error, discoveredUrl, cancelled) {
      if (isSettled) {
        return;
      }

      isSettled = true;
      clearTimeout(timeout);
      self.pendingCleanups.delete(cancel);
      if (browser) {
        browser.stop();
      }
      bonjour.destroy();
      if (!cancelled) callback(error, discoveredUrl);
    }

    browser = bonjour.find({ type: "http", protocol: "tcp" }, function (service) {
      var discoveredUrl = self.getHomebridgeDiscoveryUrl(configuredUrl, service);

      if (discoveredUrl) {
        finish(null, discoveredUrl);
      }
    });

    timeout = setTimeout(function () {
      finish(new Error("No matching Homebridge web service was discovered"), null);
    }, 3000);
  },

  getHomebridgeDiscoveryUrl: function (configuredUrl, service) {
    var configured = this.parseSimpleUrl(configuredUrl);
    var serviceName = String(service && service.name || "");
    var addresses = service && Array.isArray(service.addresses) ? service.addresses : [];
    var address = addresses.find(function (candidate) {
      return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(candidate);
    });

    if (!/homebridge/i.test(serviceName) || Number(service && service.port) !== configured.port || !address) {
      return null;
    }

    return (configured.isHttps ? "https://" : "http://") + address + ":" + configured.port;
  },

  authenticateHomebridge: function (baseUrl, username, password, verifySSL, callback) {
    var urlInfo = this.parseSimpleUrl(baseUrl);
    var isSettled = false;
    var body = JSON.stringify({ username: username, password: password, otp: "" });
    var lib = urlInfo.isHttps ? https : http;

    function safeCallback(err, token, expiresAt) {
      if (isSettled) {
        return;
      }

      isSettled = true;
      callback(err, token, expiresAt);
    }

    var options = {
      hostname: urlInfo.hostname,
      port: urlInfo.port,
      path: "/api/auth/login",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      },
      timeout: 10000,
      rejectUnauthorized: verifySSL !== false
    };

    var req = lib.request(options, function (res) {
      var data = "";
      var bodyLength = 0;

      res.on("data", function (chunk) {
        bodyLength += chunk.length;
        if (bodyLength > MAX_RESPONSE_BYTES) {
          req.destroy(new Error("Homebridge auth response body exceeded 1 MB limit"));
          return;
        }
        data += chunk;
      });

      res.on("end", function () {
        try {
          var parsed = JSON.parse(data);

          if (parsed.access_token) {
            var expiresIn = Number(parsed.expires_in) || 28800;
            safeCallback(null, parsed.access_token, Date.now() + (expiresIn - 300) * 1000);
          } else {
            safeCallback(new Error("No access token in Homebridge auth response (HTTP " + res.statusCode + ")"));
          }
        } catch (e) {
          safeCallback(new Error("Failed to parse Homebridge auth response: " + e.message));
        }
      });
    });

    req.on("timeout", function () {
      req.destroy();
      safeCallback(new Error("Homebridge auth timed out"));
    });

    req.on("error", function (err) {
      safeCallback(new Error("Homebridge auth error: " + err.message));
    });

    req.write(body);
    req.end();
  },

  fetchHomebridgeAccessories: function (baseUrl, token, verifySSL, callback, resultMapper, username) {
    var self = this;
    var urlInfo = this.parseSimpleUrl(baseUrl);
    var isSettled = false;
    var lib = urlInfo.isHttps ? https : http;

    function safeCallback(err, result) {
      if (isSettled) {
        return;
      }

      isSettled = true;
      callback(err, result);
    }

    var options = {
      hostname: urlInfo.hostname,
      port: urlInfo.port,
      path: "/api/accessories",
      method: "GET",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json"
      },
      timeout: 10000,
      rejectUnauthorized: verifySSL !== false
    };

    var req = lib.request(options, function (res) {
      var data = "";
      var bodyLength = 0;

      res.on("data", function (chunk) {
        bodyLength += chunk.length;
        if (bodyLength > MAX_RESPONSE_BYTES) {
          req.destroy(new Error("Homebridge accessories response body exceeded 1 MB limit"));
          return;
        }
        data += chunk;
      });

      res.on("end", function () {
        if (res.statusCode === 401) {
          self.invalidateHomebridgeToken(baseUrl, username, token);
          safeCallback(new Error("Homebridge token rejected (401) — will re-authenticate next cycle"));
          return;
        }

        try {
          var accessories = JSON.parse(data);

          if (res.statusCode !== 200) {
            safeCallback(new Error(self.getHomebridgeAccessoriesError(res.statusCode, res.statusMessage, accessories)));
            return;
          }

          safeCallback(null, resultMapper ? resultMapper(accessories) : self.buildHomebridgePowerMap(accessories));
        } catch (e) {
          safeCallback(new Error("Failed to parse Homebridge accessories: " + e.message));
        }
      });
    });

    req.on("timeout", function () {
      req.destroy();
      safeCallback(new Error("Homebridge accessories request timed out"));
    });

    req.on("error", function (err) {
      safeCallback(new Error("Homebridge accessories error: " + err.message));
    });

    req.end();
  },

  getHomebridgeAccessoriesError: function (statusCode, statusMessage, responseBody) {
    var responseMessage = responseBody && (responseBody.message || responseBody.error);

    if (Array.isArray(responseMessage)) {
      responseMessage = responseMessage.join(", ");
    } else if (responseMessage && typeof responseMessage === "object") {
      responseMessage = responseMessage.message;
    }

    if (String(responseMessage || "").toLowerCase().indexOf("insecure mode") !== -1) {
      return "Homebridge accessory access requires insecure mode (-I): " + responseMessage;
    }

    return "Homebridge accessories HTTP " + statusCode + ": " + (responseMessage || statusMessage || "Unknown error");
  },

  buildHomebridgePowerMap: function (accessories) {
    var powerMap = {};

    (Array.isArray(accessories) ? accessories : []).forEach(function (accessory) {
      var characteristics = Array.isArray(accessory.serviceCharacteristics)
        ? accessory.serviceCharacteristics
        : [];
      var consumptionCharacteristic = characteristics.find(function (characteristic) {
        return characteristic && String(characteristic.uuid || "").toUpperCase() === HOMEBRIDGE_CURRENT_CONSUMPTION_UUID;
      });
      var numericValue;
      var names;

      if (!consumptionCharacteristic || consumptionCharacteristic.value === "" || consumptionCharacteristic.value === null) {
        return;
      }

      numericValue = Number(consumptionCharacteristic.value);
      if (!Number.isFinite(numericValue)) {
        return;
      }

      names = [
        accessory.accessoryInformation && accessory.accessoryInformation.Name,
        accessory.accessoryInformation && accessory.accessoryInformation["Serial Number"],
        consumptionCharacteristic.serviceName
      ];

      names.forEach(function (name) {
        var normalizedName = String(name || "").trim().toLowerCase();

        if (normalizedName) {
          powerMap[normalizedName] = Math.round(numericValue * 10) / 10;
        }
      });
    });

    return powerMap;
  },

  buildHomebridgeStatusMap: function (accessories) {
    var statusMap = {};

    (Array.isArray(accessories) ? accessories : []).forEach(function (accessory) {
      var characteristics = Array.isArray(accessory.serviceCharacteristics)
        ? accessory.serviceCharacteristics
        : [];
      var consumptionCharacteristic = characteristics.find(function (characteristic) {
        return characteristic && String(characteristic.uuid || "").toUpperCase() === HOMEBRIDGE_CURRENT_CONSUMPTION_UUID;
      });
      var onCharacteristics = characteristics.filter(function (characteristic) {
        return characteristic && String(characteristic.uuid || "").toUpperCase() === HOMEBRIDGE_ON_UUID;
      });
      var onCharacteristic = onCharacteristics.find(function (characteristic) {
        return String(characteristic.serviceName || "") === String(consumptionCharacteristic && consumptionCharacteristic.serviceName || "");
      }) || onCharacteristics[0];
      var watts;
      var status;
      var names;

      if (!consumptionCharacteristic || consumptionCharacteristic.value === "" || consumptionCharacteristic.value === null) {
        return;
      }

      watts = Number(consumptionCharacteristic.value);
      if (!Number.isFinite(watts)) {
        return;
      }

      status = {
        watts: Math.round(watts * 10) / 10,
        isOn: this.resolveHomebridgeOutletPowerState(onCharacteristic, watts)
      };
      names = [
        accessory.accessoryInformation && accessory.accessoryInformation.Name,
        accessory.accessoryInformation && accessory.accessoryInformation["Serial Number"],
        consumptionCharacteristic.serviceName,
        onCharacteristic && onCharacteristic.serviceName
      ];

      names.forEach(function (name) {
        var normalizedName = String(name || "").trim().toLowerCase();

        if (normalizedName) {
          statusMap[normalizedName] = status;
        }
      });
    }.bind(this));

    return statusMap;
  },

  resolveHomebridgeOutletPowerState: function (onCharacteristic, watts) {
    if (Number.isFinite(watts) && Math.round(watts * 10) / 10 > 0) {
      return true;
    }

    return onCharacteristic ? this.normalizeBoolean(onCharacteristic.value, undefined) : undefined;
  },

  buildHomebridgeOutletMap: function (accessories) {
    var outletMap = {};

    (Array.isArray(accessories) ? accessories : []).forEach(function (accessory) {
      var characteristics = Array.isArray(accessory.serviceCharacteristics)
        ? accessory.serviceCharacteristics
        : [];
      var consumptionCharacteristic = characteristics.find(function (characteristic) {
        return characteristic && String(characteristic.uuid || "").toUpperCase() === HOMEBRIDGE_CURRENT_CONSUMPTION_UUID;
      });
      var onCharacteristics = characteristics.filter(function (characteristic) {
        return characteristic && String(characteristic.uuid || "").toUpperCase() === HOMEBRIDGE_ON_UUID;
      });
      var onCharacteristic = onCharacteristics.find(function (characteristic) {
        return String(characteristic.serviceName || "") === String(consumptionCharacteristic && consumptionCharacteristic.serviceName || "");
      }) || onCharacteristics[0];
      var watts;
      var outlet;
      var names;

      if (!consumptionCharacteristic || !onCharacteristic || !accessory.uniqueId || !onCharacteristic.type) {
        return;
      }

      var rawWatts = consumptionCharacteristic.value;
      if ((typeof rawWatts !== "number" && typeof rawWatts !== "string") ||
          (typeof rawWatts === "string" && !rawWatts.trim())) {
        return;
      }
      watts = Number(rawWatts);
      if (!Number.isFinite(watts) || watts < 0 || onCharacteristic.canWrite === false) {
        return;
      }

      outlet = {
        watts: watts,
        isOn: this.normalizeBoolean(onCharacteristic.value, undefined),
        uniqueId: String(accessory.uniqueId),
        characteristicType: String(onCharacteristic.type)
      };
      names = [
        accessory.accessoryInformation && accessory.accessoryInformation.Name,
        accessory.accessoryInformation && accessory.accessoryInformation["Serial Number"],
        consumptionCharacteristic.serviceName,
        onCharacteristic.serviceName
      ];

      names.forEach(function (name) {
        var normalizedName = String(name || "").trim().toLowerCase();

        if (normalizedName) {
          outletMap[normalizedName] = outlet;
        }
      });
    }.bind(this));

    return outletMap;
  },

  buildHomebridgeOccupancyMap: function (accessories) {
    var occupancyMap = {};

    (Array.isArray(accessories) ? accessories : []).forEach(function (accessory) {
      var characteristics = Array.isArray(accessory.serviceCharacteristics)
        ? accessory.serviceCharacteristics
        : [];
      var occupancyCharacteristic = characteristics.find(function (characteristic) {
        return characteristic && String(characteristic.uuid || "").toUpperCase() === HOMEBRIDGE_OCCUPANCY_UUID;
      });
      var names;

      if (!occupancyCharacteristic) {
        return;
      }

      names = [
        accessory.accessoryInformation && accessory.accessoryInformation.Name,
        occupancyCharacteristic.serviceName
      ];

      names.forEach(function (name) {
        var normalizedName = String(name || "").trim().toLowerCase();

        if (normalizedName) {
          occupancyMap[normalizedName] = Number(occupancyCharacteristic.value) === 1;
        }
      });
    });

    return occupancyMap;
  },

  setHomebridgeOutletState: function (url, username, password, verifySSL, uniqueId, characteristicType, value, callback, allowDiscovery) {
    var self = this;
    var targetUrl = allowDiscovery === false ? url : (this.homebridgeFallbackUrls[url] || url);

    this.withHomebridgeToken(targetUrl, username, password, verifySSL, function (error, token) {
      if (error) {
        callback(error);
        return;
      }

      self.writeHomebridgeCharacteristic(targetUrl, token, verifySSL, uniqueId, characteristicType, value, callback, username);
    });
  },

  writeHomebridgeCharacteristic: function (baseUrl, token, verifySSL, uniqueId, characteristicType, value, callback, username) {
    var self = this;
    var urlInfo = this.parseSimpleUrl(baseUrl);
    var isSettled = false;
    var body = JSON.stringify({
      characteristicType: characteristicType,
      value: value
    });
    var lib = urlInfo.isHttps ? https : http;

    function safeCallback(error) {
      if (isSettled) {
        return;
      }

      isSettled = true;
      callback(error);
    }

    var options = {
      hostname: urlInfo.hostname,
      port: urlInfo.port,
      path: "/api/accessories/" + encodeURIComponent(uniqueId),
      method: "PUT",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      },
      timeout: 10000,
      rejectUnauthorized: verifySSL !== false
    };

    var req = lib.request(options, function (res) {
      var responseBody = "";
      var bodyLength = 0;

      res.on("data", function (chunk) {
        bodyLength += chunk.length;
        if (bodyLength > MAX_RESPONSE_BYTES) {
          req.destroy(new Error("Homebridge characteristic response body exceeded 1 MB limit"));
          return;
        }
        responseBody += chunk;
      });

      res.on("end", function () {
        if (res.statusCode === 401) {
          self.invalidateHomebridgeToken(baseUrl, username, token);
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          safeCallback(new Error("Homebridge characteristic HTTP " + res.statusCode + ": " + (responseBody || res.statusMessage || "Unknown error")));
          return;
        }

        safeCallback(null);
      });
    });

    req.on("timeout", function () {
      req.destroy();
      safeCallback(new Error("Homebridge characteristic request timed out"));
    });

    req.on("error", function (error) {
      safeCallback(new Error("Homebridge characteristic error: " + error.message));
    });

    req.write(body);
    req.end();
  },

  applyHomebridgePower: function (devices, powerMap) {
    return devices.map(function (device) {
      var identifiers = [device.deviceId, device.deviceName];
      var matchingIdentifier = identifiers.find(function (identifier) {
        var normalizedIdentifier = String(identifier || "").toLowerCase().trim();

        return normalizedIdentifier && Object.prototype.hasOwnProperty.call(powerMap, normalizedIdentifier);
      });

      if (matchingIdentifier) {
        var homebridgeStatus = powerMap[String(matchingIdentifier).toLowerCase().trim()];
        var powerConsumption = typeof homebridgeStatus === "object" ? homebridgeStatus.watts : homebridgeStatus;
        var enrichment = { powerConsumption: powerConsumption };

        if (typeof homebridgeStatus === "object" && typeof homebridgeStatus.isOn === "boolean") {
          enrichment.powerState = homebridgeStatus.isOn;
          enrichment.source = "homebridge";
        }

        return Object.assign({}, device, enrichment);
      }

      return device;
    });
  },

  parseSimpleUrl: function (urlString) {
    var parsedUrl = new URL(this.canonicalizeHomebridgeOrigin(urlString));
    var isHttps = parsedUrl.protocol === "https:";

    return {
      isHttps: isHttps,
      hostname: parsedUrl.hostname,
      port: Number(parsedUrl.port) || (isHttps ? 443 : 80)
    };
  }
};
