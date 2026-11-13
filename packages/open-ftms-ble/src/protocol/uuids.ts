/** 16-bit Bluetooth SIG service UUIDs used by this library. */
export const SERVICE = {
  fitnessMachine: 0x1826,
  heartRate: 0x180d,
  cyclingPower: 0x1818,
  deviceInformation: 0x180a,
} as const;

/** 16-bit Bluetooth SIG characteristic UUIDs used by this library. */
export const CHARACTERISTIC = {
  // Fitness Machine Service
  fitnessMachineFeature: 0x2acc,
  indoorBikeData: 0x2ad2,
  trainingStatus: 0x2ad3,
  supportedSpeedRange: 0x2ad4,
  supportedInclinationRange: 0x2ad5,
  supportedResistanceLevelRange: 0x2ad6,
  supportedHeartRateRange: 0x2ad7,
  supportedPowerRange: 0x2ad8,
  fitnessMachineControlPoint: 0x2ad9,
  fitnessMachineStatus: 0x2ada,
  // Heart Rate Service
  heartRateMeasurement: 0x2a37,
  bodySensorLocation: 0x2a38,
  // Cycling Power Service
  cyclingPowerMeasurement: 0x2a63,
  cyclingPowerFeature: 0x2a65,
  // Device Information Service
  modelNumber: 0x2a24,
  serialNumber: 0x2a25,
  firmwareRevision: 0x2a26,
  hardwareRevision: 0x2a27,
  softwareRevision: 0x2a28,
  manufacturerName: 0x2a29,
} as const;

/** Expands a 16-bit SIG UUID to its 128-bit string form (lowercase). */
export function toFullUuid(shortUuid: number): string {
  return `0000${shortUuid.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
}

/** Normalises a 16-bit number or a UUID string to the lowercase 128-bit form. */
export function normalizeUuid(uuid: number | string): string {
  if (typeof uuid === 'number') return toFullUuid(uuid);
  const lower = uuid.toLowerCase();
  return /^[0-9a-f]{4}$/.test(lower) ? toFullUuid(Number.parseInt(lower, 16)) : lower;
}

const NAMES = new Map<string, string>(
  [...Object.entries(SERVICE), ...Object.entries(CHARACTERISTIC)].map(([name, short]) => [
    toFullUuid(short),
    name,
  ]),
);

/** Human-readable name for a known service/characteristic UUID (16-bit or 128-bit). */
export function uuidName(uuid: number | string): string | undefined {
  return NAMES.get(normalizeUuid(uuid));
}
