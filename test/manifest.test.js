// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ACTIONS, MAX_VOLUME } from '../src/constants.js';
import { buildDevice } from '../src/model.js';
import { assertCoreDevice } from './helpers/coreFeature.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');

const CORE_NORMALIZE = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
const normalizeSupportedOptions = existsSync(CORE_NORMALIZE)
  ? createRequire(import.meta.url)(CORE_NORMALIZE).normalizeSupportedOptions
  : undefined;

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) {
      yield* texts(entry, `${path}[${i}]`);
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

const allFields = [
  ...manifest.config_schema,
  ...manifest.actions.flatMap((item) => item.fields ?? []),
];

test('the store basics: one version everywhere, never pinned', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.equal(manifest.countries, undefined, 'sold worldwide: no countries');
  assert.equal(manifest.keywords, undefined);
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.name, 'gladys-anthem');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-anthem:${manifest.version}`);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  // The SDK is a range, never pinned.
  assert.match(pkg.dependencies['@gladysassistant/integration-sdk'], /^\^0\.16\./);
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/LM1LC3N7/gladys-anthem/main/cover.png',
  );
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['multimedia']);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /not\s+affiliated\s+with\s+Anthem|sans\s+lien\s+avec\s+Anthem/i);
    assert.match(
      docs,
      /never been tested with a real device|jamais été testée avec un vrai appareil/i,
      'say it was never tested',
    );
  }
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
  for (const field of allFields.filter((f) => f.placeholder !== undefined)) {
    assert.equal(typeof field.placeholder, 'object', `${field.key}: placeholder`);
  }
});

test('no network capture, no extra container', () => {
  assert.equal(manifest.network_discovery, undefined);
  assert.equal(manifest.network_wake, undefined);
  assert.equal(manifest.containers, undefined);
});

test('the configuration matches the code; no secret, no gladys_ key', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    assert.deepEqual(fields[key].default, value, key);
  }
  for (const field of manifest.config_schema.filter((f) => f.default !== undefined)) {
    assert.ok(field.key in DEFAULT_CONFIG, `${field.key} has no default in the code`);
  }
  for (const field of manifest.config_schema) {
    assert.doesNotMatch(field.key, /^gladys_/, field.key);
  }
  assert.deepEqual(
    [fields.max_volume.min, fields.max_volume.max, fields.max_volume.default],
    [MAX_VOLUME.min, MAX_VOLUME.max, MAX_VOLUME.default],
  );
  assert.equal(manifest.config_schema.filter((f) => f.type === 'secret').length, 0, 'no secret');
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(
      section.required ?? section.default ?? section.placeholder,
      undefined,
      section.key,
    );
    assert.ok(!(section.key in DEFAULT_CONFIG), section.key);
    for (const lang of ['en', 'fr']) {
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang}`);
    }
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
});

test('the actions are the ones the code handles', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  for (const action of manifest.actions) {
    assert.ok(action.timeout_seconds <= 60, action.key);
  }
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.scene_triggers, undefined);
  assert.equal(manifest.widgets, undefined);
});

test('the image ships the license and the third-party notices', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /COPY [^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /python-anthemav 1\.4\.2/);
  assert.match(notices, /Copyright \(c\) 2016 David McNett/);
  assert.match(notices, /Permission is hereby granted, free of charge/);
});

test('every feature has the core fields; no switch; the source options follow the core rules', () => {
  const gladys = createFakeGladys({ selector: 'anthem' });
  const device = {
    id: '10.0.0.2_14999',
    host: '10.0.0.2',
    port: 14999,
    model: 'MRX 1140',
    zones: [1, 2],
    inputs: [
      { value: '1', label: 'Blu-ray' },
      { value: '2', label: 'TV' },
    ],
  };
  for (const zone of [1, 2]) {
    const built = buildDevice(gladys, device, zone);
    assert.equal(assertCoreDevice(built, `zone ${zone}`), 8);
    assert.equal(built.should_poll, false);
    for (const f of built.features) {
      assert.notEqual(f.category, 'switch', f.external_id);
      if (f.type === 'binary') {
        assert.equal(f.read_only, true, `${f.external_id}: a binary is read only`);
      }
    }
    const source = built.features.find((f) => f.external_id.endsWith(':source'));
    for (const option of source.supported_options) {
      assert.deepEqual(Object.keys(option).sort(), ['label', 'value']);
      assert.equal(typeof option.label, 'string');
      assert.ok(option.label.length > 0 && option.label === option.label.trim());
    }
    if (normalizeSupportedOptions) {
      assert.deepEqual(
        normalizeSupportedOptions(source.supported_options, { allowStringValues: true }).map(
          ({ value, label }) => ({ value, label }),
        ),
        source.supported_options,
      );
    }
  }
  // No input known yet: an empty list (the core syncs it to none).
  const bare = buildDevice(gladys, { ...device, inputs: [] }, 1);
  assert.deepEqual(
    bare.features.find((f) => f.external_id.endsWith(':source')).supported_options,
    [],
  );
});
