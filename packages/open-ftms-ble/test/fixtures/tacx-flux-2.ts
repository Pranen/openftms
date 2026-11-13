/**
 * Packets recorded from a real Tacx Flux 2 (model T2980, firmware 3.3.45)
 * with Chrome 157 on Windows 11, 2026-11-13. Hex as shown in the demo log.
 */
export const TACX_FLUX_2 = {
  /** Advertised name; the suffix is the serial number. */
  name: 'Tacx Flux-2 26370',
  deviceInformation: { manufacturerName: 'Tacx', modelNumber: 'T2980', firmwareRevision: '3.3.45' },
  /** Machine Status (0x2ADA) present, Training Status (0x2AD3) absent, Cycling Power Service offered too. */
  characteristics: { indoorBikeData: true, controlPoint: true, machineStatus: true, trainingStatus: false },
  hasCyclingPowerService: true,
  /** 0x2ACC: machine 0x00004082, target setting 0x0000a00c. */
  fitnessMachineFeature: '82 40 00 00 0c a0 00 00',
  /** 0x2AD8: 0 … 800 W, increment 1. */
  supportedPowerRange: '00 00 20 03 01 00',
  /** 0x2AD6: 0 … 100.0, increment 0.1 (6-byte sint16 form). */
  supportedResistanceLevelRange: '00 00 e8 03 01 00',
  /** 0x2AD2: flags 0x0044 = speed + cadence + power, never resistance; ~1 Hz while idle. */
  indoorBikeData: {
    idle: '44 00 00 00 00 00 00 00',
    coasting: '44 00 c2 01 00 00 00 00', // 4.50 km/h, 0 rpm, 0 W
    pedalling: '44 00 5e 01 16 00 09 00', // 3.50 km/h, 11.0 rpm, 9 W
    spinDown: '44 00 e6 00 00 00 10 00', // 2.30 km/h, 0 rpm, 16 W (flywheel still reports power)
  },
  /** 0x2AD9 indication answering Request Control (~300 ms after the write). */
  requestControlResponse: '80 00 01',
} as const;

/** Heart-rate strap recorded in the same session (flags 0x06: contact supported + detected, uint8). */
export const HEART_RATE_STRAP = {
  measurement: '06 4e', // 78 bpm
} as const;
