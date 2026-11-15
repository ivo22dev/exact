// Interactive Android device & emulator (AVD) selector for local development.
// Lists connected ADB devices (including running emulators paired with their AVD names)
// and offline AVDs, lets the user pick one with ↑/↓ or number keys, and boots an offline
// AVD automatically waiting until `sys.boot_completed=1` before setting ANDROID_SERIAL.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const suffix = process.platform === 'win32' ? '.exe' : '';

export function findAndroidSdk(env = process.env) {
  return env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT
    ?? (process.platform === 'win32' && env.LOCALAPPDATA ? resolve(env.LOCALAPPDATA, 'Android/Sdk') : null)
    ?? resolve(homedir(), process.platform === 'darwin' ? 'Library/Android/sdk' : process.platform === 'win32' ? 'AppData/Local/Android/Sdk' : 'Android/Sdk');
}

function adbBin(env = process.env) {
  const sdk = findAndroidSdk(env);
  const candidate = resolve(sdk, `platform-tools/adb${suffix}`);
  return existsSync(candidate) ? candidate : 'adb';
}

function emulatorBin(env = process.env) {
  const sdk = findAndroidSdk(env);
  const candidate = resolve(sdk, `emulator/emulator${suffix}`);
  return existsSync(candidate) ? candidate : 'emulator';
}

function readProp(adb, serial, prop) {
  const res = spawnSync(adb, ['-s', serial, 'shell', 'getprop', prop], { encoding: 'utf8', timeout: 3000, windowsHide: true });
  return res.status === 0 ? (res.stdout ?? '').trim() : '';
}

function readEmuAvdName(adb, serial) {
  const prop = readProp(adb, serial, 'ro.boot.qemu.avd_name') || readProp(adb, serial, 'qemu.avd_name');
  if (prop) return prop;
  const res = spawnSync(adb, ['-s', serial, 'emu', 'avd', 'name'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
  if (res.status !== 0) return null;
  const lines = (res.stdout ?? '').split(/\r?\n/).map(l => l.trim()).filter(l => l && l !== 'OK');
  return lines[0] ?? null;
}

/** Collect all ADB devices and all configured AVDs, merging running emulators with their AVD entry. */
export function listAndroidTargets(env = process.env) {
  const adb = adbBin(env), emu = emulatorBin(env);
  const avdOut = spawnSync(emu, ['-list-avds'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const avds = avdOut.status === 0
    ? (avdOut.stdout ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    : [];

  const devOut = spawnSync(adb, ['devices', '-l'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const rawDevices = devOut.status === 0
    ? (devOut.stdout ?? '').split(/\r?\n/).slice(1).map(l => l.trim()).filter(Boolean)
    : [];

  const runningByAvd = new Map();
  const targets = [];

  for (const line of rawDevices) {
    const parts = line.split(/\s+/);
    const serial = parts[0], state = parts[1];
    if (!serial || !state) continue;
    const isEmulator = serial.startsWith('emulator-');
    const ready = state === 'device' && (!isEmulator || readProp(adb, serial, 'sys.boot_completed') === '1');
    const model = /model:(\S+)/.exec(line)?.[1] ?? (state === 'device' ? readProp(adb, serial, 'ro.product.model') : '') ?? '';
    const avdName = isEmulator ? readEmuAvdName(adb, serial) : null;
    if (avdName) runningByAvd.set(avdName, serial);

    const statusLabel = ready
      ? '🟢 ADB listo'
      : state === 'device'
        ? '🟡 Iniciando sistema Android (esperando boot)...'
        : `🟡 ADB (${state})`;

    targets.push({
      kind: isEmulator ? 'emulator-running' : 'device',
      serial,
      avd: avdName,
      ready,
      state,
      label: isEmulator
        ? `${avdName ? `${avdName} (${serial})` : serial} [Emulador levantado — ${statusLabel}]`
        : `${model ? `${model} (${serial})` : serial} [Dispositivo físico — ${statusLabel}]`,
    });
  }

  for (const avd of avds) {
    if (runningByAvd.has(avd)) continue;
    targets.push({
      kind: 'emulator-offline',
      serial: null,
      avd,
      ready: false,
      state: 'offline',
      label: `${avd} [Emulador apagado — ⚫ se iniciará automáticamente al seleccionarlo]`,
    });
  }

  return { targets, adb, emu };
}

/** Interactive arrow-key / number-key menu on stderr so `--json` stdout remains clean. */
async function promptSelection(targets) {
  return new Promise((resolveChoice) => {
    let index = 0;
    const out = process.stderr;
    const totalLines = targets.length + 2;

    const render = (first = false) => {
      if (!first) out.write(`\x1b[${totalLines}A`);
      out.write('\x1b[2K\r\x1b[1;36m? Seleccioná el dispositivo o emulador Android:\x1b[0m \x1b[90m(↑/↓, 1-9, Enter, Ctrl+C para cancelar)\x1b[0m\n');
      for (let i = 0; i < targets.length; i++) {
        const active = i === index;
        const prefix = active ? '\x1b[36m❯\x1b[0m' : ' ';
        const text = active ? `\x1b[1m${i + 1}) ${targets[i].label}\x1b[0m` : `\x1b[90m${i + 1})\x1b[0m ${targets[i].label}`;
        out.write(`\x1b[2K\r  ${prefix} ${text}\n`);
      }
      out.write('\x1b[2K\r\n');
    };

    render(true);

    const wasRaw = process.stdin.isRaw;
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.off('data', onData);
      if (process.stdin.setRawMode) process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
    };

    const onData = (buf) => {
      const s = buf.toString('utf8');
      if (s === '\u0003' || s === 'q' || s === 'Q') {
        cleanup();
        out.write('\x1b[31m✖ Selección cancelada.\x1b[0m\n');
        resolveChoice(null);
        return;
      }
      if (s === '\r' || s === '\n') {
        cleanup();
        resolveChoice(targets[index]);
        return;
      }
      if (s === '\u001b[A' || s === 'k') {
        index = (index - 1 + targets.length) % targets.length;
        render(false);
        return;
      }
      if (s === '\u001b[B' || s === 'j') {
        index = (index + 1) % targets.length;
        render(false);
        return;
      }
      if (/^[1-9]$/.test(s)) {
        const n = Number(s) - 1;
        if (n < targets.length) {
          index = n;
          render(false);
          cleanup();
          resolveChoice(targets[index]);
        }
      }
    };

    process.stdin.on('data', onData);
  });
}

async function waitForEmulatorBoot(adb, avd, existingSerials, timeoutMs = 180_000) {
  const started = Date.now();
  process.stderr.write(`⏳ Esperando a que el emulador "${avd}" levante y ADB esté listo`);
  while (Date.now() - started < timeoutMs) {
    const devOut = spawnSync(adb, ['devices'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
    const serials = (devOut.stdout ?? '')
      .split(/\r?\n/)
      .slice(1)
      .map(l => l.trim().split(/\s+/))
      .filter(([id, st]) => id?.startsWith('emulator-') && st === 'device')
      .map(([id]) => id);

    const candidate = serials.find(s => !existingSerials.has(s))
      ?? serials.find(s => readEmuAvdName(adb, s) === avd);

    if (candidate && readProp(adb, candidate, 'sys.boot_completed') === '1') {
      process.stderr.write(`\n✅ Emulador ${avd} (${candidate}) levantado y ADB listo.\n`);
      return candidate;
    }
    process.stderr.write('.');
    await new Promise(ok => setTimeout(ok, 1500));
  }
  process.stderr.write('\n');
  throw new Error(`Tiempo de espera agotado iniciando el emulador "${avd}".`);
}

/**
 * Prompts the user to pick an ADB device or AVD emulator when running an Android command
 * interactively without `ANDROID_SERIAL` already set.
 */
export async function ensureAndroidTargetInteractive(env = process.env) {
  if (env.ANDROID_SERIAL) return env.ANDROID_SERIAL;
  const { targets, adb, emu } = listAndroidTargets(env);
  if (!targets.length) return null;

  // If non-interactive (e.g., CI or piped), only proceed automatically if a ready device exists.
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    const ready = targets.find(t => t.ready && t.serial);
    if (ready) {
      env.ANDROID_SERIAL = ready.serial;
      return ready.serial;
    }
    return null;
  }

  const existingSerials = new Set(targets.filter(t => t.serial).map(t => t.serial));
  const choice = await promptSelection(targets);
  if (!choice) process.exit(130);

  if (choice.kind === 'emulator-offline') {
    process.stderr.write(`🚀 Iniciando emulador "${choice.avd}"...\n`);
    const child = spawn(emu, ['-avd', choice.avd], {
      detached: process.platform !== 'win32',
      windowsHide: false,
      stdio: 'ignore',
    });
    child.unref();
    const serial = await waitForEmulatorBoot(adb, choice.avd, existingSerials);
    env.ANDROID_SERIAL = serial;
    return serial;
  }

  if (!choice.ready && choice.serial) {
    const serial = await waitForEmulatorBoot(adb, choice.avd ?? choice.serial, new Set());
    env.ANDROID_SERIAL = serial;
    return serial;
  }

  process.stderr.write(`✅ Seleccionado: ${choice.label}\n`);
  env.ANDROID_SERIAL = choice.serial;
  return choice.serial;
}
