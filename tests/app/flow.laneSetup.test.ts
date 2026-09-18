import { describe, expect, it } from 'vitest';
import { SessionFlow, type FlowEffect, type FlowInput, type FlowOptions, type PoseSnapshot } from '../../src/app/flow';

const NO_POSE: PoseSnapshot = {
  tracking: false,
  calibrated: false,
  mode: null,
  startProgress: 0,
  calibration: { progress: 0, bodyVisible: false, distance: 'ok' },
  dark: false,
};
const pose = (p: Partial<PoseSnapshot>): FlowInput => ({ type: 'pose', status: { ...NO_POSE, ...p } });
const FULL = pose({ tracking: true, calibrated: true, mode: 'full' });
const SMALL = pose({ tracking: true, calibrated: true, mode: 'small' });
const UNCALIBRATED = pose({ tracking: true, calibration: { progress: 0.3, bodyVisible: true, distance: 'ok' } });
const types = (fx: FlowEffect[]) => fx.map((e) => e.type);

/** A returning webcam player on the ready screen, calibrated in `mode`. */
function ready(mode: 'full' | 'small' = 'full', opts: Partial<FlowOptions> = {}): SessionFlow {
  const f = new SessionFlow({ input: 'webcam', moveCheckSeen: true, ...opts });
  f.dispatch({ type: 'startPressed' });
  f.dispatch({ type: 'startPressed' });
  f.dispatch({ type: 'cameraOk' });
  f.dispatch(mode === 'full' ? FULL : SMALL);
  expect(f.screen).toBe('ready');
  return f;
}

/** The lane setup, opened from the ready screen. */
function inSetup(opts: Partial<FlowOptions> = {}): SessionFlow {
  const f = ready('full', opts);
  expect(f.dispatch({ type: 'setLanes' })).toEqual([{ type: 'startLaneSetup' }]);
  expect(f.screen).toBe('laneSetup');
  return f;
}

describe('SessionFlow: opening the lane setup', () => {
  it('opens from the ready screen for a calibrated full-body player', () => {
    const f = ready();
    expect(f.model.showLaneSetup).toBe(true);
    expect(f.dispatch({ type: 'setLanes' })).toEqual([{ type: 'startLaneSetup' }]);
    expect(f.screen).toBe('laneSetup');
    expect(f.model.screen).toBe('laneSetup');
  });

  it('is not offered, and does nothing, in small-room mode', () => {
    const f = ready('small');
    expect(f.model.showLaneSetup).toBe(false);
    expect(f.dispatch({ type: 'setLanes' })).toEqual([]);
    expect(f.screen).toBe('ready');
  });

  it('is not offered on any other screen', () => {
    const f = new SessionFlow({ input: 'webcam', moveCheckSeen: true });
    expect(f.model.showLaneSetup).toBe(false);
    f.dispatch({ type: 'startPressed' });
    f.dispatch({ type: 'startPressed' });
    f.dispatch({ type: 'cameraOk' });
    expect(f.model.showLaneSetup).toBe(false); // calibrating
  });

  it('asking twice does not restart it', () => {
    const f = inSetup();
    expect(f.dispatch({ type: 'setLanes' })).toEqual([]);
    expect(f.screen).toBe('laneSetup');
  });

  it('from the menu with the camera open and a calibration, goes straight in', () => {
    const f = ready();
    f.dispatch({ type: 'home' });
    expect(f.screen).toBe('menu');
    expect(f.dispatch({ type: 'setLanes' })).toEqual([{ type: 'startLaneSetup' }]);
    expect(f.screen).toBe('laneSetup');
  });

  it('from the menu with no camera, walks the player through the camera and calibration first', () => {
    // A brand-new player, who would normally get the move check after calibrating.
    const f = new SessionFlow({ input: 'webcam', moveCheckSeen: false });
    expect(f.dispatch({ type: 'setLanes' })).toEqual([]);
    expect(f.screen).toBe('cameraPrompt');
    expect(types(f.dispatch({ type: 'startPressed' }))).toEqual(['openCamera']);
    f.dispatch({ type: 'cameraOk' });
    expect(f.screen).toBe('calibrating');
    f.dispatch(UNCALIBRATED);
    expect(f.screen).toBe('calibrating');
    // The setup was asked for, so it wins over the unprompted move check.
    expect(f.dispatch(FULL)).toEqual([{ type: 'startLaneSetup' }]);
    expect(f.screen).toBe('laneSetup');
  });

  it('with the camera open but no calibration, calibrates first, then opens', () => {
    const f = new SessionFlow({ input: 'webcam', moveCheckSeen: true });
    f.dispatch({ type: 'cameraOk' }); // granted at boot, still on the menu
    expect(f.dispatch({ type: 'setLanes' })).toEqual([]);
    expect(f.screen).toBe('calibrating');
    expect(f.dispatch(FULL)).toEqual([{ type: 'startLaneSetup' }]);
  });

  it('a pending request is dropped when the calibration turns out small-room', () => {
    const f = new SessionFlow({ input: 'webcam', moveCheckSeen: true });
    f.dispatch({ type: 'cameraOk' });
    f.dispatch({ type: 'setLanes' });
    expect(f.dispatch(SMALL)).toEqual([]);
    expect(f.screen).toBe('ready');
    // And it does not come back later out of nowhere.
    f.dispatch(pose({ tracking: true }));
    f.dispatch(FULL);
    expect(f.screen).toBe('ready');
  });

  it('Home or Esc on the way there cancels the request', () => {
    for (const out of [{ type: 'home' }, { type: 'back' }] as FlowInput[]) {
      const f = new SessionFlow({ input: 'webcam', moveCheckSeen: true });
      f.dispatch({ type: 'cameraOk' });
      f.dispatch({ type: 'setLanes' });
      f.dispatch(out);
      expect(f.screen).toBe('menu');
      f.dispatch({ type: 'startPressed' }); // a quick start: calibrate and play, no setup
      expect(f.dispatch(FULL)).toEqual([]);
      expect(f.screen).toBe('ready');
    }
  });

  it('ignored with no camera anywhere but the menu, and entirely in keyboard mode', () => {
    const f = new SessionFlow({ input: 'webcam' });
    f.dispatch({ type: 'startPressed' });
    expect(f.screen).toBe('cameraPrompt');
    expect(f.dispatch({ type: 'setLanes' })).toEqual([]);
    expect(f.screen).toBe('cameraPrompt');
    const k = new SessionFlow({ input: 'keyboard' });
    expect(k.dispatch({ type: 'setLanes' })).toEqual([]);
    expect(k.screen).toBe('menu');
  });
});

describe('SessionFlow: over a run', () => {
  function withRun(state: 'countdown' | 'playing' | 'paused' | 'summary', pausedByLoss = false): SessionFlow {
    const f = ready();
    f.dispatch({ type: 'startPressed' });
    f.dispatch({ type: 'gameState', state, pausedByLoss });
    expect(f.screen).toBe('playing');
    return f;
  }

  it('pins a live run down before the setup covers it (the mustPause rule)', () => {
    for (const state of ['countdown', 'playing'] as const) {
      const f = withRun(state);
      expect(types(f.dispatch({ type: 'setLanes' })), state).toEqual(['pauseGame', 'startLaneSetup']);
    }
    const lost = withRun('paused', true);
    expect(types(lost.dispatch({ type: 'setLanes' }))).toEqual(['pauseGame', 'startLaneSetup']);
  });

  it('a run already paused by hand is left alone', () => {
    const f = withRun('paused');
    expect(types(f.dispatch({ type: 'setLanes' }))).toEqual(['startLaneSetup']);
  });

  it('Save / Cancel go back to the paused run, not the menu', () => {
    const f = withRun('paused');
    f.dispatch({ type: 'setLanes' });
    expect(types(f.dispatch({ type: 'lanesDone' }))).toEqual(['endLaneSetup']);
    expect(f.screen).toBe('playing');
  });

  it('Esc also goes back to the run on screen', () => {
    const f = withRun('paused');
    f.dispatch({ type: 'setLanes' });
    expect(types(f.dispatch({ type: 'back' }))).toEqual(['endLaneSetup']);
    expect(f.screen).toBe('playing');
  });
});

describe('SessionFlow: inside the lane setup', () => {
  it('Save / Cancel from a setup opened on the ready screen go back to it', () => {
    const f = inSetup();
    expect(f.dispatch({ type: 'lanesDone' })).toEqual([{ type: 'endLaneSetup' }]);
    expect(f.screen).toBe('ready');
  });

  it('lanesDone means nothing anywhere else', () => {
    const f = ready();
    expect(f.dispatch({ type: 'lanesDone' })).toEqual([]);
    expect(f.screen).toBe('ready');
  });

  it('ignores the start gesture and Enter: only Save or Cancel answer it', () => {
    const f = inSetup();
    expect(f.dispatch({ type: 'startGesture' })).toEqual([]);
    expect(f.dispatch({ type: 'startPressed' })).toEqual([]);
    expect(f.screen).toBe('laneSetup');
  });

  it('keeps going while the player steps out of view (tracking lost, still calibrated)', () => {
    const f = inSetup();
    expect(f.dispatch(pose({ tracking: false, calibrated: true, mode: 'full' }))).toEqual([]);
    expect(f.screen).toBe('laneSetup');
  });
});

describe('SessionFlow: every way out of the lane setup tears it down', () => {
  const exits: [string, FlowInput, string][] = [
    ['Home', { type: 'home' }, 'menu'],
    ['Esc', { type: 'back' }, 'menu'],
    ['Cancel / Save', { type: 'lanesDone' }, 'ready'],
    ['recalibrate', { type: 'recalibrate' }, 'calibrating'],
    ['mode change', { type: 'chooseMode', mode: 'small' }, 'calibrating'],
    ['camera failure', { type: 'cameraFailed', message: 'unplugged' }, 'cameraError'],
    ['another camera', { type: 'chooseCamera', id: 'usb' }, 'cameraStarting'],
    ['the keyboard', { type: 'useKeyboard' }, 'playing'],
  ];
  it.each(exits)('%s', (_name, input, screen) => {
    const f = inSetup();
    const fx = types(f.dispatch(input));
    expect(fx[0]).toBe('endLaneSetup');
    expect(fx.filter((t) => t === 'endLaneSetup')).toHaveLength(1);
    expect(fx).not.toContain('startLaneSetup');
    expect(f.screen).toBe(screen);
  });

  it('the calibration going away under it', () => {
    const f = inSetup();
    expect(types(f.dispatch(pose({ tracking: true })))).toEqual(['endLaneSetup']);
    expect(f.screen).toBe('calibrating');
  });
});

describe('SessionFlow: coming back to the setup', () => {
  it('after a recalibration asked for inside it, the setup opens again — not the move check', () => {
    const f = inSetup();
    f.dispatch({ type: 'recalibrate' });
    f.dispatch(pose({ tracking: true }));
    expect(f.dispatch(FULL)).toEqual([{ type: 'startLaneSetup' }]);
    expect(f.screen).toBe('laneSetup');
  });

  it('after the calibration is lost under it (a monitor recalibration), likewise', () => {
    const f = inSetup();
    f.dispatch(pose({ tracking: true }));
    expect(f.dispatch(FULL)).toEqual([{ type: 'startLaneSetup' }]);
  });

  it('after a switch to small-room mode, it does not come back: spots do not apply there', () => {
    const f = inSetup();
    f.dispatch({ type: 'chooseMode', mode: 'small' });
    f.dispatch(pose({ tracking: true }));
    expect(f.dispatch(SMALL)).toEqual([]);
    expect(f.screen).toBe('ready');
  });

  it('a recalibration from the ready screen goes to the move check as before', () => {
    const f = ready();
    f.dispatch({ type: 'recalibrate' });
    f.dispatch(pose({ tracking: true }));
    expect(f.dispatch(FULL)).toEqual([{ type: 'startMoveCheck' }]);
  });

  it('a camera failure is an exit: a retry does not reopen it', () => {
    const f = inSetup();
    f.dispatch({ type: 'cameraFailed', message: 'x' });
    f.dispatch({ type: 'retry' });
    f.dispatch({ type: 'cameraOk' });
    // Still calibrated from before the failure: straight to the ready screen.
    f.dispatch(FULL);
    expect(f.screen).toBe('ready');
  });
});
