import type { ControlPointResponse } from './protocol/ftms/control-point';

/** Base class for every error thrown by open-ftms-ble. */
export class OpenFtmsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A value passed to an encoder is not finite or does not fit its wire format. */
export class InvalidParameterError extends OpenFtmsError {}

/** The browser/OS offers no Web Bluetooth (wrong browser, no adapter, insecure context). */
export class BluetoothUnavailableError extends OpenFtmsError {}

/** The user closed the device chooser without selecting a device. */
export class UserCancelledError extends OpenFtmsError {}

/** Connecting failed or an established connection was lost. */
export class ConnectionError extends OpenFtmsError {}

/** An operation needs a ready connection, but the device is not connected. */
export class NotConnectedError extends ConnectionError {}

/** A GATT read/write/subscribe failed. */
export class GattOperationError extends OpenFtmsError {}

/** An operation did not complete in time. */
export class TimeoutError extends OpenFtmsError {}

/** The device does not support the requested feature (per 0x2ACC or missing characteristic). */
export class UnsupportedFeatureError extends OpenFtmsError {}

/** The trainer answered a control point command with a non-success result. */
export class ControlPointError extends OpenFtmsError {
  readonly response: ControlPointResponse;

  constructor(response: ControlPointResponse) {
    super(
      `Control point ${response.request} failed: ${response.result} (0x${response.resultCode
        .toString(16)
        .padStart(2, '0')})`,
    );
    this.response = response;
  }

  get result(): ControlPointResponse['result'] {
    return this.response.result;
  }
}

/** Wraps unknown thrown values (DOMException etc.) into the given error class. */
export function wrapError<T extends OpenFtmsError>(
  ErrorClass: new (message: string, options?: ErrorOptions) => T,
  context: string,
  cause: unknown,
): T | OpenFtmsError {
  if (cause instanceof OpenFtmsError) return cause;
  const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  return new ErrorClass(`${context} (${detail})`, { cause });
}
