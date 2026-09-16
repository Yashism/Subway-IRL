import { describe, expect, it } from 'vitest';
import { describeCameraError, isIrCamera, pickDefaultCamera } from '../../src/pose/camera';

const FHD = { deviceId: 'a', label: 'USB2.0 FHD UVC WebCam' };
const IR = { deviceId: 'b', label: 'USB2.0 IR UVC WebCam' };

describe('camera helpers', () => {
  it('recognises IR cameras', () => {
    expect(isIrCamera(IR.label)).toBe(true);
    expect(isIrCamera('Infrared Camera')).toBe(true);
    expect(isIrCamera(FHD.label)).toBe(false);
    expect(isIrCamera('Mirror Cam')).toBe(false);
  });

  it('prefers the saved camera, then the first non-IR camera', () => {
    expect(pickDefaultCamera([IR, FHD])).toEqual(FHD);
    expect(pickDefaultCamera([IR, FHD], 'b')).toEqual(IR);
    expect(pickDefaultCamera([IR, FHD], 'gone')).toEqual(FHD);
    expect(pickDefaultCamera([IR])).toEqual(IR);
    expect(pickDefaultCamera([])).toBeNull();
  });

  it('explains camera errors', () => {
    expect(describeCameraError({ name: 'NotAllowedError' })).toMatch(/permission/i);
    expect(describeCameraError({ name: 'NotReadableError' })).toMatch(/busy/i);
    expect(describeCameraError({ name: 'NotFoundError' })).toMatch(/no camera/i);
    expect(describeCameraError(new Error('boom'))).toMatch(/boom/);
  });
});
