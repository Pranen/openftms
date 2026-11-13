/** Base class for every error thrown by open-ftms-ble. */
export class OpenFtmsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A value passed to an encoder is not finite or does not fit its wire format. */
export class InvalidParameterError extends OpenFtmsError {}
