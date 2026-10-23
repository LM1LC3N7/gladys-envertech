// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized: the
// address of the EVT800 micro-inverter (with an optional port, 14889 by
// default) and the optional peak power. The address parser comes from
// gladys-omnik / gladys-imeon (approved).
// -----------------------------------------------------------------------------

import { DEFAULT_PORT } from './constants.js';

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * An address typed by the user: an IP address or a host name, with an
 * optional port. A pasted URL is reduced to its host and port.
 * @returns {{ address: string } | { error: 'invalid' }} `address` is '' when empty.
 */
export function parseAddress(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') {
    return { address: '' };
  }
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '');
  // user:password@ never belongs in the address: refused rather than sent around.
  if (text.includes('@')) {
    return { error: 'invalid' };
  }
  const bracketed = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(text);
  if (bracketed) {
    return withPort(`[${bracketed[1].toLowerCase()}]`, bracketed[2]);
  }
  if (/^[0-9a-f:.]+$/i.test(text) && (text.match(/:/g) ?? []).length >= 2) {
    return { address: `[${text.toLowerCase()}]` };
  }
  const match = /^(.*?)(?::(\d{1,5}))?$/.exec(text);
  const host = match[1];
  if (host.length > 253 || !host.split('.').every((label) => LABEL.test(label))) {
    return { error: 'invalid' };
  }
  return withPort(host.toLowerCase(), match[2]);
}

function withPort(host, port) {
  if (port === undefined) {
    return { address: host };
  }
  const number = Number(port);
  if (number < 1 || number > 65535) {
    return { error: 'invalid' };
  }
  return { address: number === DEFAULT_PORT ? host : `${host}:${number}` };
}

/**
 * The optional peak power of the panels (kWp, manifest `peak_power_kw`): a
 * number from 0.1 to 10, else undefined (the default margin is then used).
 */
export function peakOf(raw) {
  const text = typeof raw === 'string' ? raw.trim().replace(',', '.') : raw;
  if (text === '' || text === null || text === undefined) {
    return undefined;
  }
  if (typeof text === 'string' && !/^\d{1,2}(\.\d{1,3})?$/.test(text)) {
    return undefined;
  }
  const value = Number(text);
  return Number.isFinite(value) && value >= 0.1 && value <= 10 ? value : undefined;
}

export function normalizeConfig(raw = {}) {
  // An address longer than any host name is refused before any parsing.
  const value = typeof raw?.address === 'string' && raw.address.length <= 300 ? raw.address : '';
  const parsed = parseAddress(value);
  return {
    address: parsed.error ? '' : parsed.address,
    invalidAddress:
      Boolean(parsed.error) ||
      (typeof raw?.address === 'string' && value === '' && raw.address !== ''),
    peakKw: peakOf(raw?.peak_power_kw),
  };
}
