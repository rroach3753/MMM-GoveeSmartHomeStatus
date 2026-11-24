const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

test("config schema matches module defaults", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, "config.schema.json"), "utf8"));
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(root, "MMM-GoveeSmartHomeStatus.js"), "utf8"), {
    Module: { register: (_name, value) => { definition = value; } }
  });

  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(definition.defaults).sort());
  for (const [name, value] of Object.entries(definition.defaults)) {
    assert.deepEqual(schema.properties[name].default, JSON.parse(JSON.stringify(value)));
  }
});
