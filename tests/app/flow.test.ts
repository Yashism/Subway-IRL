import { describe, expect, it } from 'vitest';
import { SessionFlow, type FlowEffect, type FlowInput, type PoseSnapshot } from '../../src/app/flow';

const NO_POSE: PoseSnapshot = {
  tracking: false,
  calibrated: false,
  mode: null,
  startProgress: 0,
  calibration: { progress: 0, bodyVisible: false, distance: 'ok' },
  dark: false,
};
const pose = (p: Partial<PoseSnapshot>): FlowInput => ({ type: 'pose', status: { ...NO_POSE, ...p } });
const STANDING = pose({ tracking: true, calibration: { progress: 0.4, bodyVisible: true, distance: 'ok' } });
const CALIBRATED = pose({ tracking: true, calibrated: true, mode: 'full', calibration: { progress: 0, bodyVisible: false, distance: 'ok' } });
const types = (fx: FlowEffect[]) => fx.map((e) => e.type);

/** A webcam flow walked to the given screen. */
function webcamAt(screen: 'cameraPrompt' | 'cameraStarting' | 'cameraError' | 'calibrating' | 'ready' | 'playing'): SessionFlow {
  const f = new SessionFlow({ input: 'webcam' });
  f.dispatch({ type: 'startPressed' });
  if (screen === 'cameraPrompt') return f;
  f.dispatch({ type: 'startPressed' });
  if (screen === 'cameraStarting') return f;
  if (screen === 'cameraError') {
    f.dispatch({ type: 'cameraFailed', message: 'denied' });
    return f;
  }
  f.dispatch({ type: 'cameraOk' });
  if (screen === 'calibrating') return f;
  f.dispatch(CALIBRATED);
  if (screen === 'ready') return f;
  f.dispatch({ type: 'startPressed' });
  f.dispatch({ type: 'gameState', state: 'countdown' });
  return f;
}

describe('SessionFlow: keyboard-only', () => {
  it('starts in the menu and goes straight to the game on Enter', () => {
    const f = new SessionFlow({ input: 'keyboard' });
    expect(f.screen).toBe('menu');
    expect(f.dispatch({ type: 'startPressed' })).toEqual([{ type: 'startGame' }]);
    expect(f.screen).toBe('playing');
  });

  it('never shows a camera screen, even for camera results or retries', () => {
    const f = new SessionFlow({ input: 'keyboard' });
    for (const i of [{ type: 'cameraOk' }, { type: 'cameraFailed', message: 'x' }, { type: 'retry' }, STANDING] as FlowInput[]) {
      expect(f.dispatch(i)).toEqual([]);
      expect(f.screen).toBe('menu');
    }
  });

  it('ignores start gestures and recalibration', () => {
    const f = new SessionFlow({ input: 'keyboard' });
    expect(f.dispatch({ type: 'startGesture' })).toEqual([]);
    expect(f.dispatch({ type: 'recalibrate' })).toEqual([]);
    f.dispatch({ type: 'startPressed' });
    expect(f.dispatch({ type: 'recalibrate' })).toEqual([]);
    expect(f.screen).toBe('playing');
    expect(f.model.showRecalibrate).toBe(false);
  });

  it('can switch to webcam from the menu', () => {
    const f = new SessionFlow({ input: 'keyboard' });
    expect(f.dispatch({ type: 'useWebcam' })).toEqual([]);
    expect(f.input).toBe('webcam');
    f.dispatch({ type: 'startPressed' });
    expect(f.screen).toBe('cameraPrompt');
  });
});

describe('SessionFlow: camera setup', () => {
  it('defaults to webcam and opens the explainer on Enter', () => {
    const f = new SessionFlow();
    expect(f.input).toBe('webcam');
    expect(f.dispatch({ type: 'startPressed' })).toEqual([]);
    expect(f.screen).toBe('cameraPrompt');
  });

  it('a start gesture in the menu needs a running camera', () => {
    const f = new SessionFlow();
    expect(f.dispatch({ type: 'startGesture' })).toEqual([]);
    expect(f.screen).toBe('menu');
  });

  it('"Use webcam" opens the remembered camera', () => {
    const f = new SessionFlow({ cameraId: 'cam-2' });
    f.dispatch({ type: 'startPressed' });
    expect(f.dispatch({ type: 'startPressed' })).toEqual([{ type: 'openCamera', cameraId: 'cam-2' }]);
    expect(f.screen).toBe('cameraStarting');
  });

  it('"Play with keyboard" on the explainer starts a keyboard game', () => {
    const f = webcamAt('cameraPrompt');
    expect(f.dispatch({ type: 'useKeyboard' })).toEqual([{ type: 'startGame' }]);
    expect(f.input).toBe('keyboard');
    expect(f.screen).toBe('playing');
  });

  it('back returns from the explainer to the menu', () => {
    const f = webcamAt('cameraPrompt');
    expect(f.dispatch({ type: 'back' })).toEqual([]);
    expect(f.screen).toBe('menu');
  });

  it('camera ok → calibrating', () => {
    const f = webcamAt('cameraStarting');
    expect(f.dispatch({ type: 'cameraOk' })).toEqual([]);
    expect(f.screen).toBe('calibrating');
    expect(f.cameraReady).toBe(true);
  });

  it('camera ok with a controller that is already calibrated → ready', () => {
    const f = webcamAt('cameraStarting');
    f.dispatch(CALIBRATED);
    f.dispatch({ type: 'cameraOk' });
    expect(f.screen).toBe('ready');
  });

  it('ignores Enter while the camera is starting', () => {
    const f = webcamAt('cameraStarting');
    expect(f.dispatch({ type: 'startPressed' })).toEqual([]);
    expect(f.screen).toBe('cameraStarting');
  });

  it('camera failure shows the message', () => {
    const f = webcamAt('cameraStarting');
    expect(f.dispatch({ type: 'cameraFailed', message: 'Camera permission was denied.' })).toEqual([]);
    expect(f.screen).toBe('cameraError');
    expect(f.model.error).toBe('Camera permission was denied.');
    expect(f.cameraReady).toBe(false);
  });

  it('retry (button or Enter) opens the camera again and clears the error', () => {
    const f = webcamAt('cameraError');
    expect(f.dispatch({ type: 'retry' })).toEqual([{ type: 'openCamera', cameraId: null }]);
    expect(f.screen).toBe('cameraStarting');
    expect(f.model.error).toBe('');
    f.dispatch({ type: 'cameraFailed', message: 'busy' });
    expect(types(f.dispatch({ type: 'startPressed' }))).toEqual(['openCamera']);
  });

  it('picking another camera on the error screen opens that camera', () => {
    const f = webcamAt('cameraError');
    expect(f.dispatch({ type: 'chooseCamera', id: 'usb' })).toEqual([{ type: 'openCamera', cameraId: 'usb' }]);
    expect(f.screen).toBe('cameraStarting');
    expect(f.model.cameraId).toBe('usb');
  });

  it('"use keyboard" from the error screen starts a keyboard game without stopping a camera that never started', () => {
    const f = webcamAt('cameraError');
    expect(f.dispatch({ type: 'useKeyboard' })).toEqual([{ type: 'startGame' }]);
    expect(f.screen).toBe('playing');
    expect(f.input).toBe('keyboard');
  });

  it('"use keyboard" while the camera is starting stops it', () => {
    const f = webcamAt('cameraStarting');
    expect(f.dispatch({ type: 'useKeyboard' })).toEqual([{ type: 'stopCamera' }, { type: 'startGame' }]);
  });

  it('a camera opened early (permission already granted) keeps the menu', () => {
    const f = new SessionFlow();
    f.dispatch({ type: 'cameraOk' });
    expect(f.screen).toBe('menu');
    expect(f.cameraReady).toBe(true);
  });

  it('an early camera failure keeps the menu; Enter then shows the explainer', () => {
    const f = new SessionFlow();
    f.dispatch({ type: 'cameraFailed', message: 'nope' });
    expect(f.screen).toBe('menu');
    f.dispatch({ type: 'startPressed' });
    expect(f.screen).toBe('cameraPrompt');
  });

  it('with the camera already on, Enter in the menu skips the explainer', () => {
    const f = new SessionFlow();
    f.dispatch({ type: 'cameraOk' });
    expect(f.dispatch({ type: 'startPressed' })).toEqual([]);
    expect(f.screen).toBe('calibrating');
  });

  it('with the camera on and the player calibrated, a raised hand in the menu starts the game', () => {
    const f = new SessionFlow();
    f.dispatch({ type: 'cameraOk' });
    f.dispatch(CALIBRATED);
    expect(f.dispatch({ type: 'startGesture' })).toEqual([{ type: 'startGame' }]);
    expect(f.screen).toBe('playing');
  });

  it('switching to keyboard in the menu stops a running camera', () => {
    const f = new SessionFlow();
    f.dispatch({ type: 'cameraOk' });
    expect(f.dispatch({ type: 'useKeyboard' })).toEqual([{ type: 'stopCamera' }]);
    expect(f.screen).toBe('menu');
    expect(f.cameraReady).toBe(false);
  });
});

describe('SessionFlow: calibration', () => {
  it('stays calibrating while the player holds still, then becomes ready', () => {
    const f = webcamAt('calibrating');
    expect(f.dispatch(STANDING)).toEqual([]);
    expect(f.screen).toBe('calibrating');
    expect(f.model.progress).toBeCloseTo(0.4);
    expect(f.dispatch(CALIBRATED)).toEqual([]);
    expect(f.screen).toBe('ready');
    expect(f.model.progress).toBe(1);
    expect(f.model.detectedMode).toBe('full');
  });

  it('Enter does not skip calibration', () => {
    const f = webcamAt('calibrating');
    expect(f.dispatch({ type: 'startPressed' })).toEqual([]);
    expect(f.dispatch({ type: 'startGesture' })).toEqual([]);
    expect(f.screen).toBe('calibrating');
  });

  it('choosing a mode forces it and restarts calibration', () => {
    const f = webcamAt('calibrating');
    expect(f.dispatch({ type: 'chooseMode', mode: 'small' })).toEqual([
      { type: 'setForcedMode', mode: 'small' },
      { type: 'recalibrate' },
    ]);
    expect(f.model.modeChoice).toBe('small');
    expect(f.dispatch({ type: 'chooseMode', mode: 'auto' })).toEqual([
      { type: 'setForcedMode', mode: null },
      { type: 'recalibrate' },
    ]);
  });

  it('choosing a mode before the camera runs only forces the mode', () => {
    const f = new SessionFlow();
    expect(f.dispatch({ type: 'chooseMode', mode: 'full' })).toEqual([{ type: 'setForcedMode', mode: 'full' }]);
    expect(f.screen).toBe('menu');
    const k = new SessionFlow({ input: 'keyboard' });
    expect(k.dispatch({ type: 'chooseMode', mode: 'full' })).toEqual([]);
  });

  it('choosing the same mode again does nothing', () => {
    const f = webcamAt('calibrating');
    expect(f.dispatch({ type: 'chooseMode', mode: 'auto' })).toEqual([]);
  });

  it('choosing a mode when ready goes back to calibrating', () => {
    const f = webcamAt('ready');
    expect(types(f.dispatch({ type: 'chooseMode', mode: 'full' }))).toEqual(['setForcedMode', 'recalibrate']);
    expect(f.screen).toBe('calibrating');
  });

  it('switching camera reopens it and recalibrates', () => {
    const f = webcamAt('ready');
    expect(f.dispatch({ type: 'chooseCamera', id: 'b' })).toEqual([{ type: 'openCamera', cameraId: 'b' }, { type: 'recalibrate' }]);
    expect(f.screen).toBe('cameraStarting');
    expect(f.cameraReady).toBe(false);
  });

  it('choosing the camera already in use does nothing', () => {
    const f = new SessionFlow({ cameraId: 'a' });
    f.dispatch({ type: 'startPressed' });
    f.dispatch({ type: 'startPressed' });
    f.dispatch({ type: 'cameraOk' });
    expect(f.dispatch({ type: 'chooseCamera', id: 'a' })).toEqual([]);
    expect(f.screen).toBe('calibrating');
  });

  it('recalibrate on the ready screen', () => {
    const f = webcamAt('ready');
    expect(f.dispatch({ type: 'recalibrate' })).toEqual([{ type: 'recalibrate' }]);
    expect(f.screen).toBe('calibrating');
  });

  it('losing calibration elsewhere (monitor) drops back to calibrating', () => {
    const f = webcamAt('ready');
    f.dispatch(STANDING);
    expect(f.screen).toBe('calibrating');
  });

  it('a camera that dies during calibration shows the error', () => {
    const f = webcamAt('calibrating');
    f.dispatch({ type: 'cameraFailed', message: 'unplugged' });
    expect(f.screen).toBe('cameraError');
  });

  it('back from calibration returns to the menu and keeps the camera', () => {
    const f = webcamAt('calibrating');
    expect(f.dispatch({ type: 'back' })).toEqual([]);
    expect(f.screen).toBe('menu');
    expect(f.cameraReady).toBe(true);
  });

  it('"use keyboard" from calibration stops the camera and starts', () => {
    const f = webcamAt('calibrating');
    expect(f.dispatch({ type: 'useKeyboard' })).toEqual([{ type: 'stopCamera' }, { type: 'startGame' }]);
    expect(f.input).toBe('keyboard');
  });
});

describe('SessionFlow: ready → play', () => {
  it('a raised right hand starts the game', () => {
    const f = webcamAt('ready');
    expect(f.dispatch({ type: 'startGesture' })).toEqual([{ type: 'startGame' }]);
    expect(f.screen).toBe('playing');
  });

  it('Enter starts the game too', () => {
    const f = webcamAt('ready');
    expect(f.dispatch({ type: 'startPressed' })).toEqual([{ type: 'startGame' }]);
    expect(f.screen).toBe('playing');
  });

  it('shows the start-hold progress while ready', () => {
    const f = webcamAt('ready');
    f.dispatch(pose({ tracking: true, calibrated: true, mode: 'full', startProgress: 0.5 }));
    expect(f.model.startProgress).toBe(0.5);
    expect(f.model.message).toMatch(/Raise your RIGHT hand/);
  });
});

describe('SessionFlow: playing', () => {
  it('ignores Enter (the keyboard drives the game directly) and start gestures mid-run', () => {
    const f = webcamAt('playing');
    f.dispatch({ type: 'gameState', state: 'playing' });
    expect(f.dispatch({ type: 'startPressed' })).toEqual([]);
    expect(f.dispatch({ type: 'startGesture' })).toEqual([]);
    expect(f.screen).toBe('playing');
  });

  it('shows the recalibrate button in webcam play', () => {
    expect(webcamAt('playing').model.showRecalibrate).toBe(true);
  });

  it('recalibrating mid-run pauses the game first', () => {
    const f = webcamAt('playing');
    f.dispatch({ type: 'gameState', state: 'playing' });
    expect(f.dispatch({ type: 'recalibrate' })).toEqual([{ type: 'pauseGame' }, { type: 'recalibrate' }]);
    expect(f.screen).toBe('calibrating');
  });

  it('after recalibrating mid-run, a raised hand resumes', () => {
    const f = webcamAt('playing');
    f.dispatch({ type: 'gameState', state: 'playing' });
    f.dispatch({ type: 'recalibrate' });
    f.dispatch({ type: 'gameState', state: 'paused' });
    f.dispatch(CALIBRATED);
    expect(f.dispatch({ type: 'startGesture' })).toEqual([{ type: 'startGame' }]);
    expect(f.screen).toBe('playing');
  });

  it('changing mode mid-run pauses, forces the mode and recalibrates', () => {
    const f = webcamAt('playing');
    f.dispatch({ type: 'gameState', state: 'countdown' });
    expect(types(f.dispatch({ type: 'chooseMode', mode: 'small' }))).toEqual(['pauseGame', 'setForcedMode', 'recalibrate']);
    expect(f.screen).toBe('calibrating');
  });

  it('recalibrating from the summary does not pause', () => {
    const f = webcamAt('playing');
    f.dispatch({ type: 'gameState', state: 'summary' });
    expect(f.dispatch({ type: 'recalibrate' })).toEqual([{ type: 'recalibrate' }]);
  });

  it('a raised hand resumes a game paused with Esc', () => {
    const f = webcamAt('playing');
    f.dispatch({ type: 'gameState', state: 'paused' });
    expect(f.dispatch({ type: 'startGesture' })).toEqual([{ type: 'startGame' }]);
  });

  it('a camera that dies mid-run pauses and shows the error; retry then resumes via ready', () => {
    const f = webcamAt('playing');
    f.dispatch({ type: 'gameState', state: 'playing' });
    expect(f.dispatch({ type: 'cameraFailed', message: 'gone' })).toEqual([{ type: 'pauseGame' }]);
    expect(f.screen).toBe('cameraError');
    f.dispatch({ type: 'gameState', state: 'paused' });
    f.dispatch({ type: 'retry' });
    f.dispatch({ type: 'cameraOk' });
    expect(f.screen).toBe('ready');
    expect(f.dispatch({ type: 'startGesture' })).toEqual([{ type: 'startGame' }]);
  });

  it('switching to keyboard mid-run stops the camera and keeps playing', () => {
    const f = webcamAt('playing');
    expect(f.dispatch({ type: 'useKeyboard' })).toEqual([{ type: 'stopCamera' }]);
    expect(f.screen).toBe('playing');
    expect(f.model.showRecalibrate).toBe(false);
  });

  it('stores pose status while playing without changing screen', () => {
    const f = webcamAt('playing');
    f.dispatch(pose({ tracking: false, calibrated: true, mode: 'small' }));
    expect(f.screen).toBe('playing');
    expect(f.model.detectedMode).toBe('small');
  });
});

describe('SessionFlow: play again', () => {
  function atSummary(): SessionFlow {
    const f = webcamAt('playing');
    f.dispatch({ type: 'gameState', state: 'playing' });
    f.dispatch({ type: 'gameState', state: 'caught' });
    f.dispatch({ type: 'gameState', state: 'summary' });
    return f;
  }

  it('shows "Raise hand to play again" on the summary', () => {
    const f = atSummary();
    expect(f.model.playAgain).toMatch(/Raise your right hand to play again/i);
    f.dispatch({ type: 'gameState', state: 'countdown' });
    expect(f.model.playAgain).toBe('');
  });

  it('no play-again hint in keyboard mode', () => {
    const f = new SessionFlow({ input: 'keyboard' });
    f.dispatch({ type: 'startPressed' });
    f.dispatch({ type: 'gameState', state: 'summary' });
    expect(f.model.playAgain).toBe('');
  });

  it('a raised hand while calibrated and tracked restarts without recalibrating', () => {
    const f = atSummary();
    f.dispatch(CALIBRATED);
    expect(f.dispatch({ type: 'startGesture' })).toEqual([{ type: 'startGame' }]);
    expect(f.screen).toBe('playing');
  });

  it('the quick re-check sends a player who is not tracked to the ready screen', () => {
    const f = atSummary();
    f.dispatch(pose({ tracking: false, calibrated: true, mode: 'full' }));
    expect(f.dispatch({ type: 'startGesture' })).toEqual([]);
    expect(f.screen).toBe('ready');
    expect(f.model.recheck).toBe(true);
    expect(f.model.message).toMatch(/Step into view/);
    f.dispatch(CALIBRATED);
    expect(f.model.message).toMatch(/Raise your RIGHT hand/);
    expect(f.dispatch({ type: 'startGesture' })).toEqual([{ type: 'startGame' }]);
  });

  it('the quick re-check falls back to calibration if the baseline is gone', () => {
    const f = atSummary();
    f.dispatch(STANDING);
    expect(f.dispatch({ type: 'startGesture' })).toEqual([]);
    expect(f.screen).toBe('calibrating');
  });

  it('a fresh calibration clears the re-check flag', () => {
    const f = atSummary();
    f.dispatch(pose({ tracking: false, calibrated: true, mode: 'full' }));
    f.dispatch({ type: 'startGesture' });
    f.dispatch({ type: 'recalibrate' });
    f.dispatch(CALIBRATED);
    expect(f.model.recheck).toBe(false);
    expect(f.model.message).toMatch(/^Calibrated!/);
  });
});

describe('SessionFlow: screen model', () => {
  it('checklist and hints follow the calibration state', () => {
    const f = webcamAt('calibrating');
    let m = f.model;
    expect(m.checks).toEqual({ body: 'bad', distance: 'pending', light: 'ok' });
    expect(m.hint).toBe('Step into view');

    f.dispatch(pose({ tracking: true, calibration: { progress: 0, bodyVisible: true, distance: 'back' } }));
    m = f.model;
    expect(m.checks).toEqual({ body: 'ok', distance: 'bad', light: 'ok' });
    expect(m.hint).toBe('Step back — show your knees');

    f.dispatch(pose({ tracking: true, calibration: { progress: 0, bodyVisible: true, distance: 'closer' } }));
    expect(f.model.hint).toBe('Come closer');

    f.dispatch(pose({ tracking: true, dark: true, calibration: { progress: 0.2, bodyVisible: true, distance: 'ok' } }));
    m = f.model;
    expect(m.checks).toEqual({ body: 'ok', distance: 'ok', light: 'bad' });
    expect(m.hint).toBe('Too dark — turn on a light');

    f.dispatch(STANDING);
    expect(f.model.hint).toBe('');
    expect(f.model.message).toBe('Hold still…');
  });

  it('a stale model object is not mutated by later dispatches', () => {
    const f = webcamAt('calibrating');
    const before = f.model;
    f.dispatch(STANDING);
    expect(before.progress).toBe(0);
    expect(f.model).not.toBe(before);
  });

  it('returns the same model object while nothing changes', () => {
    const f = webcamAt('calibrating');
    f.dispatch(STANDING);
    const a = f.model;
    f.dispatch(STANDING);
    expect(f.model).toBe(a);
  });

  it('ready shows all checks ok and the calibrated message', () => {
    const m = webcamAt('ready').model;
    expect(m.checks).toEqual({ body: 'ok', distance: 'ok', light: 'ok' });
    expect(m.message).toBe('Calibrated! Raise your RIGHT hand to start (or press Enter)');
  });

  it('reports the input mode and the url-forced mode choice', () => {
    const f = new SessionFlow({ input: 'webcam', modeChoice: 'small' });
    expect(f.model.input).toBe('webcam');
    expect(f.model.modeChoice).toBe('small');
  });
});
