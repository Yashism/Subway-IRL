import { describe, expect, it } from 'vitest';
import { nextMode } from '../../src/app/flow';
import { MSG_CALIBRATED, MSG_STEP_IN, MSG_WELCOME_BACK } from '../../src/app/flow';
import { cameraOptions, checkMark, messageParts, modeChipLabel, ringDash, screenCopy, warningToast } from '../../src/ui/poseScreens';
import { isDark, isStalled, modeBadge, pipVisibleFromUrl, trackingLevel } from '../../src/ui/pip';

describe('cameraOptions', () => {
  const cams = [
    { deviceId: 'ir', label: 'Integrated IR Camera' },
    { deviceId: 'rgb', label: 'Integrated Camera' },
    { deviceId: 'usb', label: 'Logitech C920' },
  ];

  it('hides IR cameras and marks the chosen one', () => {
    expect(cameraOptions(cams, 'usb')).toEqual([
      { id: 'rgb', label: 'Integrated Camera', selected: false },
      { id: 'usb', label: 'Logitech C920', selected: true },
    ]);
  });

  it('selects the first camera when the saved one is missing', () => {
    expect(cameraOptions(cams, 'gone').map((o) => o.selected)).toEqual([true, false]);
    expect(cameraOptions(cams, null)[0].selected).toBe(true);
  });

  it('keeps an IR camera (labelled) when it is the only one, rather than an empty list', () => {
    expect(cameraOptions([cams[0]], null)).toEqual([{ id: 'ir', label: 'Integrated IR Camera (IR)', selected: true }]);
    expect(cameraOptions([], null)).toEqual([]);
  });
});

describe('modeChipLabel / nextMode', () => {
  it('names the choice and the detected mode under Auto', () => {
    expect(modeChipLabel('auto', null)).toBe('Auto');
    expect(modeChipLabel('auto', 'small')).toBe('Auto · Small room');
    expect(modeChipLabel('full', 'full')).toBe('Full body');
    expect(modeChipLabel('small', null)).toBe('Small room');
  });

  it('cycles auto → full → small → auto', () => {
    expect(nextMode('auto')).toBe('full');
    expect(nextMode('full')).toBe('small');
    expect(nextMode('small')).toBe('auto');
  });
});

describe('small view helpers', () => {
  it('check marks are a distinct icon per state', () => {
    const marks = (['ok', 'bad', 'pending'] as const).map(checkMark);
    for (const m of marks) expect(m).toMatch(/^<svg /);
    expect(new Set(marks).size).toBe(3);
  });

  it('ring dash offset empties at 0 and fills at 1, clamped', () => {
    expect(ringDash(0, 100)).toBe('100.0');
    expect(ringDash(1, 100)).toBe('0.0');
    expect(ringDash(0.25, 100)).toBe('75.0');
    expect(ringDash(2, 100)).toBe('0.0');
    expect(ringDash(Number.NaN, 100)).toBe('100.0');
  });

  it('warning toast: stalled beats slow', () => {
    expect(warningToast(false, false)).toBeNull();
    expect(warningToast(true, false)).toEqual({ level: 'slow', text: 'Camera is slow — tracking may lag' });
    expect(warningToast(true, true)).toEqual({ level: 'stalled', text: 'Camera stalled — pausing' });
  });

  it('warning toast: only promises to pause when there is a run to pause', () => {
    expect(warningToast(false, true, true)).toEqual({ level: 'stalled', text: 'Camera stalled — pausing' });
    expect(warningToast(false, true, false)).toEqual({ level: 'stalled', text: 'Camera stalled — no frames coming in' });
    expect(warningToast(true, false, false)).toEqual({ level: 'slow', text: 'Camera is slow — tracking may lag' });
  });

  it('splits the ready message into banner, pill and small print', () => {
    expect(messageParts(MSG_CALIBRATED)).toEqual({
      head: 'Calibrated!',
      main: 'Raise your RIGHT hand to start',
      sub: 'or press Enter',
    });
    expect(messageParts(MSG_STEP_IN)).toEqual({ head: '', main: 'Step into view', sub: 'then raise your RIGHT hand' });
    expect(messageParts(MSG_WELCOME_BACK).head).toBe('Looking good!');
    expect(messageParts('Step back — show your knees')).toEqual({ head: '', main: 'Step back — show your knees', sub: '' });
    expect(messageParts('')).toEqual({ head: '', main: '', sub: '' });
  });

  it('every screen has title copy', () => {
    for (const s of ['cameraPrompt', 'cameraStarting', 'cameraError', 'calibrating', 'ready'] as const) {
      expect(screenCopy(s).title.length).toBeGreaterThan(0);
    }
    expect(screenCopy('cameraPrompt').body).toMatch(/never leaves/);
  });
});

describe('pip helpers', () => {
  it('tracking level: lost or stalled is red, slow is amber, else green', () => {
    expect(trackingLevel(true, false, false)).toBe('ok');
    expect(trackingLevel(true, true, false)).toBe('slow');
    expect(trackingLevel(false, false, false)).toBe('lost');
    expect(trackingLevel(true, false, true)).toBe('lost');
  });

  it('stall detection', () => {
    expect(isStalled(null, 5000)).toBe(false);
    expect(isStalled(1000, 2400)).toBe(false);
    expect(isStalled(1000, 2600)).toBe(true);
    expect(isStalled(1000, 1300, 200)).toBe(true);
  });

  it('dark frames', () => {
    expect(isDark(null)).toBe(false);
    expect(isDark(20)).toBe(true);
    expect(isDark(120)).toBe(false);
  });

  it('mode badge', () => {
    expect(modeBadge('full')).toBe('FULL');
    expect(modeBadge('small')).toBe('SMALL');
    expect(modeBadge(null)).toBe('—');
  });

  it('visibility from the url', () => {
    expect(pipVisibleFromUrl('')).toBe(true);
    expect(pipVisibleFromUrl('?pip=0')).toBe(false);
    expect(pipVisibleFromUrl('?pip=off')).toBe(false);
    expect(pipVisibleFromUrl('?nopip')).toBe(false);
    expect(pipVisibleFromUrl('?pip=1')).toBe(true);
  });
});
