/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — camera control feature
 *                     |                             | barrel (?app=camera). All imports go through here (FSD: no
 *                     |                             | deep imports). GoPro-first, pluggable CameraProvider; the
 *                     |                             | controller-side service/fleet/remote-proxy + the sim and real
 *                     |                             | GoPro engines are all exported from this single surface.
 */

export type {
  CameraProviderKind as CameraKind,
  CameraLink,
  CameraMode,
  CameraStatus,
  CameraCommand,
  CameraCapture,
  CameraSettings,
  CameraTelemetry,
  CameraEvent,
} from './model/camera-types';
export { CameraCommandError, type CameraProvider, type CameraProviderKind } from './services/camera-provider';
export {
  CAMERA_ID_RE,
  DESTRUCTIVE_CAMERA_OPS,
  normalizeCameraCommand,
  normalizeCameraCapture,
  normalizeCameraSettings,
} from './services/camera-validator';
export { SimCameraProvider, type SimCameraOptions } from './services/sim-camera-provider';
export { GoProCameraProvider, goproUsbBaseUrl, type GoProCameraOptions, type CameraFetch } from './services/gopro-camera-provider';
export { RemoteCameraProvider, type CameraNodeHeartbeat } from './services/remote-camera-provider';
export { CameraFleet, CAMERA_HEARTBEAT_STALE_MS, type CameraFleetSummary } from './services/camera-fleet';
export {
  CameraService,
  CameraConfirmationRequiredError,
  DEFAULT_CAMERA_ID,
  type CameraCommandContext,
} from './services/camera-service';
