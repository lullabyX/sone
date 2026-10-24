import { atom } from 'jotai';

export interface ConnectDevice {
  id: string;
  name: string;
  modelName: string;
  host: string;
  port: number;
  addresses: string[];
  txtRecords: Record<string, string>;
  isLocal: boolean;
}

export const localDevice: ConnectDevice = {
  id: 'local',
  name: 'This Computer (Local Audio)',
  modelName: 'Sone Local DAC',
  host: 'localhost',
  port: 0,
  addresses: ['127.0.0.1'],
  txtRecords: {},
  isLocal: true,
};

export const availableDevicesAtom = atom<ConnectDevice[]>([localDevice]);
export const activeDeviceAtom = atom<ConnectDevice>(localDevice);
/**
 * True whenever playback routes to a TIDAL Connect receiver instead of the
 * local DAC. Derived purely from the selection: with a receiver selected,
 * every play/set_volume command goes to the cast path by design, so the
 * signal-path panel and quality badge treat the LOCAL pipeline as idle.
 */
export const isCastingAtom = atom(
  (get) => get(activeDeviceAtom).id !== localDevice.id,
);
export const isConnectModalOpenAtom = atom<boolean>(false);
export const isScanningDevicesAtom = atom<boolean>(false);
