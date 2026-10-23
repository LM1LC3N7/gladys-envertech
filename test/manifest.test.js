// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACTIONS } from '../src/constants.js';
import { normalizeConfig, parseAddress, peakOf } from '../src/config.js';
import { buildDevice, keepCreatedFeatures } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const index = read('index.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) {
      yield* texts(item, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

const external = {
  device: 'ext:envertech:inverter:31525820',
  feature: (key) => `ext:envertech:inverter:31525820:${key}`,
};
const gladys = { externalIds: () => external };

test('the store basics; one version everywhere (the Release workflow owns it)', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-envertech:${manifest.version}`);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(pkg.name, 'gladys-envertech');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.deepEqual(manifest.categories, ['energy']);
  assert.deepEqual(manifest.transports, ['local']);
  assert.match(manifest.gladys_version, />=\s*5\.2\.0/);
  assert.match(
    manifest.cover_image,
    /^https:\/\/raw\.githubusercontent\.com\/LM1LC3N7\/gladys-envertech\//,
  );
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /Non officiel/);
});

test('the cover is an 800 x 534 PNG', () => {
  const png = readFileSync(new URL('../cover.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 534);
});

test('the docs say it was never tested with a real device', () => {
  assert.match(read('docs/fr.md'), /[Jj]amais\s+testé\s+avec\s+un\s+vrai\s+appareil/);
  assert.match(read('docs/en.md'), /[Nn]ever\s+tested\s+with\s+a\s+real\s+device/);
  assert.match(read('README.md'), /[Nn]ever\s+tested\s+with\s+a\s+real\s+device/);
  assert.match(manifest.config_schema[0].description.en, /Never tested with a real/);
  assert.match(manifest.config_schema[0].description.fr, /Jamais testé avec un vrai/);
});

test('every text is in English and French; placeholders too', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
  for (const field of manifest.config_schema) {
    if ('placeholder' in field) {
      assert.equal(typeof field.placeholder, 'object', `${field.key}.placeholder`);
    }
  }
});

test('the configuration matches the code: address and peak power, no secret', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(fields), ['intro', 'address', 'peak_power_kw']);
  assert.equal(fields.address.type, 'string');
  assert.equal(fields.address.required, true);
  assert.ok(!manifest.config_schema.some((f) => f.type === 'secret'));
  assert.equal(fields.peak_power_kw.type, 'number');
  assert.equal(fields.peak_power_kw.required, false);
  assert.equal(peakOf(fields.peak_power_kw.max), 10);
  assert.equal(peakOf(fields.peak_power_kw.min), 0.1);
  assert.equal(peakOf('0,8'), 0.8);
  assert.equal(peakOf('11'), undefined);
  assert.equal(peakOf(''), undefined);
  for (const link of fields.intro.links) {
    assert.match(link.url, /^https:\/\//);
  }
});

test('the address: default port 14889 dropped, others kept, junk refused', () => {
  assert.deepEqual(parseAddress(' 192.168.1.80 '), { address: '192.168.1.80' });
  assert.deepEqual(parseAddress('192.168.1.80:14889'), { address: '192.168.1.80' });
  assert.deepEqual(parseAddress('tcp://EVT.lan:1234/x'), { address: 'evt.lan:1234' });
  assert.deepEqual(parseAddress('fe80::1'), { address: '[fe80::1]' });
  assert.deepEqual(parseAddress('a@b'), { error: 'invalid' });
  assert.deepEqual(parseAddress('h:70000'), { error: 'invalid' });
  assert.equal(normalizeConfig({ address: 'bad host!' }).invalidAddress, true);
  assert.equal(normalizeConfig({ address: 'x'.repeat(400) }).invalidAddress, true);
  assert.equal(normalizeConfig({}).address, '');
});

test('the actions of the manifest are the handlers of the code; read-only', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    Object.values(ACTIONS),
  );
  assert.ok(index.includes('onAction(ACTIONS.TEST'));
  assert.ok(index.includes('onAction(ACTIONS.ACCEPT_HELD'));
  assert.ok(index.includes('onDeviceCreated'));
  assert.ok(index.includes("on('connected'"));
  assert.ok(!index.includes('onSetValue'), 'no command: read-only');
});

test('the device: core units only, the index with its 30-minute production, nothing writable', () => {
  const device = buildDevice(gladys, { serial: '31525820', channels: 2 }, { address: '1.2.3.4' });
  const units = {
    'energy-production-sensor': ['watt', 'kilowatt-hour'],
    'energy-sensor': ['volt', 'ampere'],
    'device-temperature-sensor': ['celsius'],
    unknown: [undefined],
  };
  for (const feature of device.features) {
    assert.ok(units[feature.category].includes(feature.unit), feature.external_id);
    assert.equal(feature.read_only, true);
  }
  assert.ok(!device.features.some((f) => f.category === 'temperature-sensor'));
  assert.ok(!device.features.some((f) => f.category === 'switch'));
  const indexes = device.features.filter((f) => f.type === 'index');
  assert.equal(indexes.length, 1, 'one index only');
  const thirty = device.features.find((f) => f.type === 'thirty-minutes-production');
  assert.equal(thirty.energy_parent_id, indexes[0].id);
  assert.ok(!device.features.some((f) => f.category === 'energy-sensor' && f.type === 'energy'));
  assert.ok(!device.features.some((f) => f.type === 'daily-production'));
  // The ids are stable: the same build twice gives the same ids.
  const again = buildDevice(gladys, { serial: '31525820', channels: 2 }, { address: '5.6.7.8' });
  assert.deepEqual(
    again.features.map((f) => f.id ?? f.external_id),
    device.features.map((f) => f.id ?? f.external_id),
  );
  // One input seen, two created: nothing lost.
  const one = buildDevice(gladys, { serial: '31525820', channels: 1 }, { address: '1.2.3.4' });
  const kept = keepCreatedFeatures(one, device);
  assert.equal(kept.features.length, device.features.length);
});

test('the licenses ship in the image; no name in LICENSE', () => {
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /pyenvertechevt800/);
  assert.match(notices, /Copyright \(c\) 2025 Daniel Bergmann/);
  assert.match(notices, /Permission is hereby granted, free of charge/);
  assert.match(notices, /THE SOFTWARE IS PROVIDED "AS IS"/);
});

test('the code never feeds the energy consumption endpoint nor scene events', () => {
  for (const file of ['index.js', 'src/app.js', 'src/devices.js']) {
    assert.doesNotMatch(read(file), /publishEnergyConsumption\(/, file);
    assert.doesNotMatch(read(file), /publishSceneEvent\(/, file);
  }
});
