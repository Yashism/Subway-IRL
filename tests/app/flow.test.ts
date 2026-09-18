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
const STANDING = pose({ tracking: true, calibration: { progress: 0.4, bodyVisible: true, distance: 'ok' } });
const CALIBRATED = pose({ tracking: true, calibrated: true, mode: 'full', calibration: { progress: 0, bodyVisible: false, distance: 'ok' } });
const types = (fx: FlowEffect[]) => fx.map((e) => e.type);

/** A webcam flow walked to the given screen, as a returning player (a saved tuning exists). */
function webcamAt(
  screen: 'cameraPrompt' | 'cameraStarting' | 'cameraError' | 'calibrating' | 'moveCheck' | 'ready' | 'playing',
  opts: Partial<FlowOptions> = {},
): SessionFlow {
  const f = new SessionFlow({ input: 'webcam', moveCheckSeen: true, ...opts });
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
  if (screen === 'moveCheck' || screen === 'ready') return f;
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

  it('after recalibrating mid-run, the move check runs and then a raised hand resumes', () => {
    const f = webcamAt('playing');
    f.dispatch({ type: 'gameState', state: 'playing' });
    f.dispatch({ type: 'recalibrate' });
    f.dispatch({ type: 'gameState', state: 'paused' });
    f.dispatch(CALIBRATED);
    // A recalibration always teaches the moves again, and the gesture is ignored while it is up.
    expect(f.screen).toBe('moveCheck');
    expect(f.dispatch({ type: 'startGesture' })).toEqual([]);
    // "START PLAYING" on the summary card resumes the run it interrupted.
    expect(types(f.dispatch({ type: 'startPressed' }))).toEqual(['endMoveCheck', 'startGame']);
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
    // `movecheck=skip` keeps this about the re-check flag: a recalibration otherwise runs the
    // check, whose own "START PLAYING" goes to the run rather than to the ready screen.
    const f = webcamAt('playing', { moveCheck: 'skip' });
    f.dispatch({ type: 'gameState', state: 'summary' });
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
    // The light is unknown until the first frame-luma sample lands.
    expect(m.checks).toEqual({ body: 'bad', distance: 'pending', light: 'pending' });
    expect(m.hint).toBe('Step into view');

    f.dispatch(pose({ dark: false }));
    expect(f.model.checks.light).toBe('ok');

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

  it('copies pose snapshots, so a reused (mutated) status object still updates the model', () => {
    const f = webcamAt('calibrating');
    const shared: PoseSnapshot = { ...NO_POSE, tracking: true, calibration: { progress: 0.1, bodyVisible: true, distance: 'ok' } };
    f.dispatch({ type: 'pose', status: shared });
    expect(f.model.progress).toBeCloseTo(0.1);
    shared.calibration.progress = 0.7;
    f.dispatch({ type: 'pose', status: shared });
    expect(f.model.progress).toBeCloseTo(0.7);
    shared.calibrated = true;
    f.dispatch({ type: 'pose', status: shared });
    expect(f.screen).toBe('ready');
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

describe('SessionFlow: the move check', () => {
  /** A fresh machine: no saved tuning, so the first calibration teaches the moves. */
  const firstRun = () => webcamAt('calibrating', { moveCheckSeen: false });

  it('a first-ever calibration goes to the check, a returning player straight to ready', () => {
    const fresh = firstRun();
    expect(fresh.dispatch(CALIBRATED)).toEqual([{ type: 'startMoveCheck' }]);
    expect(fresh.screen).toBe('moveCheck');

    const back = webcamAt('calibrating');
    expect(back.dispatch(CALIBRATED)).toEqual([]);
    expect(back.screen).toBe('ready');
  });

  it('a returning player is offered the check on the ready screen, in one click', () => {
    const f = webcamAt('ready');
    expect(f.model.showMoveCheck).toBe(true);
    expect(f.dispatch({ type: 'checkMoves' })).toEqual([{ type: 'startMoveCheck' }]);
    expect(f.screen).toBe('moveCheck');
    // Only from the ready screen: nowhere else has a calibrated player standing still.
    const g = webcamAt('calibrating');
    expect(g.dispatch({ type: 'checkMoves' })).toEqual([]);
    expect(g.screen).toBe('calibrating');
  });

  it('recalibrating always runs the check, even for a returning player', () => {
    const f = webcamAt('ready');
    expect(types(f.dispatch({ type: 'recalibrate' }))).toEqual(['recalibrate']);
    expect(f.dispatch(CALIBRATED)).toEqual([{ type: 'startMoveCheck' }]);
    expect(f.screen).toBe('moveCheck');
  });

  it('?movecheck=skip never runs it and never offers it', () => {
    const f = webcamAt('ready', { moveCheck: 'skip', moveCheckSeen: false });
    expect(f.screen).toBe('ready');
    expect(f.model.showMoveCheck).toBe(false);
    expect(f.dispatch({ type: 'checkMoves' })).toEqual([]);
    f.dispatch({ type: 'recalibrate' });
    expect(f.dispatch(CALIBRATED)).toEqual([]);
    expect(f.screen).toBe('ready');
  });

  it('?movecheck=force runs it even for a returning player on a first calibration', () => {
    const f = webcamAt('calibrating', { moveCheck: 'force', moveCheckSeen: true });
    expect(f.dispatch(CALIBRATED)).toEqual([{ type: 'startMoveCheck' }]);
    expect(f.screen).toBe('moveCheck');
  });

  it('"START PLAYING" really starts the run; the start gesture is ignored while the check is up', () => {
    const f = webcamAt('calibrating', { moveCheckSeen: false });
    f.dispatch(CALIBRATED);
    // The hoverboard step asks for both hands up, one hand away from the start gesture.
    expect(f.dispatch({ type: 'startGesture' })).toEqual([]);
    expect(f.screen).toBe('moveCheck');
    // The summary card lists the start gesture itself, so there is nothing left to teach: the one
    // obvious green button must not land the player on another screen telling them to press again.
    expect(types(f.dispatch({ type: 'startPressed' }))).toEqual(['endMoveCheck', 'startGame']);
    expect(f.screen).toBe('playing');
  });

  it('falls back to the ready screen when there is nothing calibrated to play with', () => {
    const f = webcamAt('calibrating', { moveCheckSeen: false });
    f.dispatch(CALIBRATED);
    f.dispatch(pose({ tracking: true, calibrated: false }));
    expect(f.screen).toBe('calibrating');
  });

  it('every other way out of the check tears it down too', () => {
    const back = firstRun();
    back.dispatch(CALIBRATED);
    expect(types(back.dispatch({ type: 'back' }))).toEqual(['endMoveCheck']);
    expect(back.screen).toBe('menu');

    const recal = firstRun();
    recal.dispatch(CALIBRATED);
    expect(types(recal.dispatch({ type: 'recalibrate' }))).toEqual(['endMoveCheck', 'recalibrate']);
    expect(recal.screen).toBe('calibrating');

    const keys = firstRun();
    keys.dispatch(CALIBRATED);
    expect(types(keys.dispatch({ type: 'useKeyboard' }))).toEqual(['endMoveCheck', 'stopCamera', 'startGame']);
    expect(keys.screen).toBe('playing');

    const mode = firstRun();
    mode.dispatch(CALIBRATED);
    expect(types(mode.dispatch({ type: 'chooseMode', mode: 'small' }))).toEqual(['endMoveCheck', 'setForcedMode', 'recalibrate']);
  });

  it('losing the calibration under the check goes back and offers it again', () => {
    const f = firstRun();
    f.dispatch(CALIBRATED);
    expect(types(f.dispatch(STANDING))).toEqual(['endMoveCheck']);
    expect(f.screen).toBe('calibrating');
    expect(f.dispatch(CALIBRATED)).toEqual([{ type: 'startMoveCheck' }]);
  });

  it('runs the check once, then leaves a returning player alone', () => {
    const f = firstRun();
    f.dispatch(CALIBRATED);
    expect(f.screen).toBe('moveCheck');
    f.dispatch({ type: 'back' });
    // What main.ts does once a tuning has been saved.
    f.setMoveCheckSeen(true);
    f.dispatch(pose({ tracking: true, calibrated: false }));
    f.dispatch({ type: 'startPressed' });
    expect(f.screen).toBe('calibrating');
    expect(f.dispatch(CALIBRATED)).toEqual([]);
    expect(f.screen).toBe('ready');
  });

  it('after "Reset to defaults" the next new player is taught again', () => {
    const f = webcamAt('ready');
    f.setMoveCheckSeen(false);
    f.dispatch(STANDING);
    expect(f.dispatch(CALIBRATED)).toEqual([{ type: 'startMoveCheck' }]);
  });

  it('a run paused by a lost pose is pinned down before the check takes the screen', () => {
    const f = webcamAt('playing');
    f.dispatch({ type: 'gameState', state: 'paused', pausedByLoss: true });
    // Without the pause the run would resume behind the check's scrim the moment tracking returns.
    expect(types(f.dispatch({ type: 'recalibrate' }))).toEqual(['pauseGame', 'recalibrate']);
    expect(f.dispatch(CALIBRATED)).toEqual([{ type: 'startMoveCheck' }]);
    expect(f.screen).toBe('moveCheck');
  });
});

describe('SessionFlow: Home', () => {
  it('goes back to the menu from every screen there is, abandoning the run on screen', () => {
    for (const screen of ['cameraPrompt', 'cameraStarting', 'cameraError', 'calibrating', 'moveCheck', 'ready'] as const) {
      const f = webcamAt(screen, { moveCheckSeen: screen !== 'moveCheck' });
      const fx = types(f.dispatch({ type: 'home' }));
      expect(f.screen, screen).toBe('menu');
      // Only the check screen has anything to tear down, and no run is on screen on any of these.
      expect(fx, screen).toEqual(screen === 'moveCheck' ? ['endMoveCheck'] : []);
    }
  });

  it('abandons a live run without scoring it, and the camera stays open for the next one', () => {
    const f = webcamAt('playing');
    f.dispatch({ type: 'gameState', state: 'playing' });
    expect(f.dispatch({ type: 'home' })).toEqual([{ type: 'homeGame' }]);
    expect(f.screen).toBe('menu');
    expect(f.cameraReady).toBe(true);
    // A raised hand from the menu goes straight back into a run, camera and calibration intact.
    f.dispatch({ type: 'gameState', state: 'menu' });
    expect(f.dispatch({ type: 'startGesture' })).toEqual([{ type: 'startGame' }]);
    expect(f.screen).toBe('playing');
  });

  it('works the same from a paused run, a summary and a countdown', () => {
    for (const state of ['paused', 'summary', 'countdown'] as const) {
      const f = webcamAt('playing');
      f.dispatch({ type: 'gameState', state });
      expect(types(f.dispatch({ type: 'home' })), state).toEqual(['homeGame']);
      expect(f.screen, state).toBe('menu');
    }
  });

  it('clears the loss-pause, so nothing resumes itself behind the menu', () => {
    const f = webcamAt('playing');
    f.dispatch({ type: 'gameState', state: 'paused', pausedByLoss: true });
    expect(types(f.dispatch({ type: 'home' }))).toEqual(['homeGame']);
    f.dispatch({ type: 'gameState', state: 'menu' });
    // A recalibration from the menu still works — the camera is open — but there is no longer a
    // run to pin down, so it must not ask for a pause.
    expect(types(f.dispatch({ type: 'recalibrate' }))).toEqual(['recalibrate']);
    expect(f.screen).toBe('calibrating');
  });

  it('is available in keyboard mode too', () => {
    const f = new SessionFlow({ input: 'keyboard' });
    f.dispatch({ type: 'startPressed' });
    f.dispatch({ type: 'gameState', state: 'playing' });
    expect(f.dispatch({ type: 'home' })).toEqual([{ type: 'homeGame' }]);
    expect(f.screen).toBe('menu');
    expect(f.dispatch({ type: 'startPressed' })).toEqual([{ type: 'startGame' }]);
  });

  it('does nothing at all when the menu is already showing and no run is live', () => {
    const f = new SessionFlow();
    expect(f.dispatch({ type: 'home' })).toEqual([]);
    expect(f.screen).toBe('menu');
  });
});

describe('the menu is a screen with a live camera on it', () => {
  /** The camera opened at boot because permission was already granted: menu, camera ready. */
  const menuWithCamera = () => {
    const f = new SessionFlow({ moveCheckSeen: true });
    f.dispatch({ type: 'cameraOk' });
    expect(f.screen).toBe('menu');
    expect(f.cameraReady).toBe(true);
    return f;
  };

  it('applies a camera chosen in Settings instead of quietly dropping it', () => {
    const f = menuWithCamera();
    expect(f.dispatch({ type: 'chooseCamera', id: 'cam-b' })).toEqual([
      { type: 'openCamera', cameraId: 'cam-b' },
      { type: 'recalibrate' },
    ]);
    // …and it swaps the stream where the player is standing, rather than walking them back
    // through the setup cards they already finished.
    expect(f.screen).toBe('menu');
    expect(f.cameraReady).toBe(false);
    f.dispatch({ type: 'cameraOk' });
    expect(f.cameraReady).toBe(true);
    expect(f.model.cameraId).toBe('cam-b');
  });

  it('ignores a choice of the camera already in use', () => {
    const f = menuWithCamera();
    f.dispatch({ type: 'chooseCamera', id: 'cam-b' });
    f.dispatch({ type: 'cameraOk' });
    expect(f.dispatch({ type: 'chooseCamera', id: 'cam-b' })).toEqual([]);
  });

  it('runs the move check when Settings asks for it from the menu', () => {
    const f = menuWithCamera();
    expect(types(f.dispatch({ type: 'recalibrate' }))).toEqual(['recalibrate']);
    expect(f.screen).toBe('calibrating');
    // The check is queued behind the calibration, which is what "redo it" has to mean.
    f.dispatch(CALIBRATED);
    expect(f.screen).toBe('moveCheck');
  });

  it('does not drag the player into a calibration for changing the play mode', () => {
    const f = menuWithCamera();
    expect(f.dispatch({ type: 'chooseMode', mode: 'small' })).toEqual([{ type: 'setForcedMode', mode: 'small' }]);
    expect(f.screen).toBe('menu');
  });

  it('still refuses all of it without a camera', () => {
    const f = new SessionFlow({ moveCheckSeen: true });
    expect(f.cameraReady).toBe(false);
    expect(f.dispatch({ type: 'recalibrate' })).toEqual([]);
    expect(f.screen).toBe('menu');
  });
});
