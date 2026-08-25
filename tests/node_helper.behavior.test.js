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

test("Homebridge power map accepts Outlet Pro characteristic variants", () => {
  const accessories = [{
    accessoryInformation: { Name: "Homebridge Outlet Name" },
    serviceCharacteristics: [{
      uuid: "e863f10d-079e-48ff-8f27-9c2605a29f52",
      serviceName: "Outlet Pro",
      value: "12.34"
    }]
  }];

  assert.deepEqual(helper.buildHomebridgePowerMap(accessories), {
    "homebridge outlet name": 12.3,
    "outlet pro": 12.3
  });
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