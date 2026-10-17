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
export const isConnectModalOpenAtom = atom<boolean>(false);
export const isScanningDevicesAtom = atom<boolean>(false);
