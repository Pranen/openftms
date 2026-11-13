import './style.css';
import { LIBRARY_NAME, LIBRARY_VERSION, isWebBluetoothAvailable } from 'open-ftms-ble';

const envStatus = document.querySelector<HTMLDivElement>('#env-status');

if (envStatus) {
  const available = isWebBluetoothAvailable();
  envStatus.textContent = available
    ? `Web Bluetooth verfügbar · ${LIBRARY_NAME} ${LIBRARY_VERSION}`
    : 'Web Bluetooth nicht verfügbar (Chrome/Edge via https oder localhost nötig)';
  envStatus.classList.add(available ? 'ok' : 'error');
}
