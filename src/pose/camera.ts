export interface CameraInfo {
  deviceId: string;
  label: string;
}

/** Windows Hello IR cameras show up as video inputs but are useless for pose tracking. */
export const isIrCamera = (label: string) => /\bIR\b|infrared/i.test(label);

export function pickDefaultCamera(cams: CameraInfo[], savedId?: string | null): CameraInfo | null {
  const saved = savedId ? cams.find((c) => c.deviceId === savedId) : undefined;
  return saved ?? cams.find((c) => !isIrCamera(c.label)) ?? cams[0] ?? null;
}

/** Labels are only filled in after camera permission has been granted. */
export async function listCameras(): Promise<CameraInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

export function openCamera(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 30 },
    },
  });
}

export function describeCameraError(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission was denied. Allow camera access in the browser address bar, then retry.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is busy. Close other apps using it (Teams, Zoom, Camera) and retry.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found. Plug one in or pick another camera, then retry.';
    default:
      return `Could not start the camera: ${err instanceof Error ? err.message : String(err)}`;
  }
}
