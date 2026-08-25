const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

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

test("Homebridge accessory API explains the insecure mode requirement", () => {
  const message = helper.getHomebridgeAccessoriesError(400, "Bad Request", {
    message: "Homebridge must be running in insecure mode to access accessories."
  });

  assert.match(message, /requires insecure mode \(-I\)/);
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