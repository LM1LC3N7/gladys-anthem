// -----------------------------------------------------------------------------
// Known devices -> Gladys devices and states (pure). One Gladys device per
// zone of each address (zone 1, and zone 2 once the device answered for it).
//
// The categories and types are the ones of the Gladys core: `music/volume`
// like the core Sonos service, `text/select` for the source, `button/push`
// for "Power on", "Power off", "Mute" and "Unmute", and the power and mute
// states read only (`unknown/binary`): no switch, nothing an "everything on
// / off" (voice assistants, scenes) could turn into a command. No unit: the
// core lists none for these categories.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { addressKey, platformId } from './config.js';
import { DEVICE_TYPE, FEATURES, VOLUME } from './constants.js';

const button = (name) => ({ name, category: C.BUTTON, type: T.BUTTON.PUSH, min: 0, max: 1 });

/** The feature definitions, by frozen key, in their frozen order. */
export const FEATURE_SPECS = Object.freeze({
  [FEATURES.POWER]: {
    name: 'Power',
    category: C.UNKNOWN,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
    read_only: true,
    keep_history: true,
  },
  [FEATURES.POWER_ON]: button('Power on'),
  [FEATURES.POWER_OFF]: button('Power off'),
  [FEATURES.VOLUME]: {
    name: 'Volume',
    category: C.MUSIC,
    type: T.MUSIC.VOLUME,
    min: VOLUME.min,
    max: VOLUME.max,
    has_feedback: true,
  },
  [FEATURES.MUTED]: {
    name: 'Muted',
    category: C.UNKNOWN,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
    read_only: true,
  },
  [FEATURES.MUTE]: button('Mute'),
  [FEATURES.UNMUTE]: button('Unmute'),
  [FEATURES.SOURCE]: {
    name: 'Source',
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    has_feedback: true,
  },
});

/** The options of the "Source" dropdown: every input this device has named. */
export const inputOptions = (device) =>
  (Array.isArray(device.inputs) ? device.inputs : []).map(({ value, label }) => ({
    value,
    label,
  }));

export function deviceName(device, zone) {
  const base = `Anthem ${device.model ?? ''} (${addressKey(device)})`.replace('  ', ' ');
  return zone === 2 ? `${base} - Zone 2` : base;
}

export const idsOf = (gladys, device, zone) =>
  gladys.externalIds(DEVICE_TYPE, platformId(device, zone));

export function buildDevice(gladys, device, zone) {
  const ids = idsOf(gladys, device, zone);
  return {
    name: deviceName(device, zone),
    external_id: ids.device,
    should_poll: false,
    params: [
      { name: 'IP_ADDRESS', value: device.host },
      { name: 'ZONE', value: String(zone) },
    ],
    // Always the full, fixed list: a device published again never loses a feature.
    features: Object.entries(FEATURE_SPECS).map(([key, { name, ...spec }]) => ({
      name,
      external_id: ids.feature(key),
      read_only: false,
      has_feedback: false,
      keep_history: false,
      ...spec,
      ...(key === FEATURES.SOURCE ? { supported_options: inputOptions(device) } : {}),
    })),
  };
}

/** The feature key of a feature external id of a device, or undefined. */
export function featureKey(deviceExternalId, featureExternalId) {
  const prefix = `${deviceExternalId}:`;
  return String(featureExternalId ?? '').startsWith(prefix)
    ? String(featureExternalId).slice(prefix.length)
    : undefined;
}

/**
 * The states of one zone. `state` is the zone state of a connected device,
 * `null` for a device that does not answer (power 0 only), undefined for
 * "nothing known" (nothing published). A field unknown is not published.
 */
export function stateList(gladys, device, zone, state) {
  if (state === undefined) {
    return [];
  }
  const ids = idsOf(gladys, device, zone);
  const id = (key) => ids.feature(key);
  if (state === null) {
    return [{ device_feature_external_id: id(FEATURES.POWER), state: 0 }];
  }
  const states = [];
  if (typeof state.power === 'boolean') {
    states.push({ device_feature_external_id: id(FEATURES.POWER), state: state.power ? 1 : 0 });
  }
  if (Number.isInteger(state.volume)) {
    states.push({ device_feature_external_id: id(FEATURES.VOLUME), state: state.volume });
  }
  if (typeof state.mute === 'boolean') {
    states.push({ device_feature_external_id: id(FEATURES.MUTED), state: state.mute ? 1 : 0 });
  }
  const input = Number.isInteger(state.input) ? String(state.input) : undefined;
  if (input && inputOptions(device).some((option) => option.value === input)) {
    states.push({ device_feature_external_id: id(FEATURES.SOURCE), text: input });
  }
  return states;
}
