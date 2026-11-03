import { useEffect, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAtom, useAtomValue } from "jotai";
import {
  Cast,
  Laptop,
  Radio,
  Check,
  X,
  RefreshCw,
} from "lucide-react";
import {
  availableDevicesAtom,
  activeDeviceAtom,
  isConnectModalOpenAtom,
  isScanningDevicesAtom,
  localDevice,
  type ConnectDevice,
} from "../atoms/tidalConnect";
import { currentTrackAtom, isPlayingAtom } from "../atoms/playback";
import { usePlaybackActions } from "../hooks/usePlaybackActions";

export const TidalConnectModal = memo(function TidalConnectModal() {
  const [isOpen, setIsOpen] = useAtom(isConnectModalOpenAtom);
  const [devices, setDevices] = useAtom(availableDevicesAtom);
  const [activeDevice, setActiveDevice] = useAtom(activeDeviceAtom);
  const [isScanning, setIsScanning] = useAtom(isScanningDevicesAtom);
  const currentTrack = useAtomValue(currentTrackAtom);
  const isPlaying = useAtomValue(isPlayingAtom);
  const { playTrack } = usePlaybackActions();

  const refreshDevices = async () => {
    setIsScanning(true);
    try {
      await invoke("tidal_connect_start_discovery");
      const fetched = await invoke<ConnectDevice[]>(
        "tidal_connect_get_available_devices"
      );
      setDevices([localDevice, ...fetched]);
    } catch (err) {
      console.error("Failed to discover TIDAL Connect devices:", err);
    } finally {
      setIsScanning(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      refreshDevices();
      const interval = setInterval(refreshDevices, 3000);
      return () => {
        clearInterval(interval);
        invoke("tidal_connect_stop_discovery").catch(() => {});
      };
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSelect = async (device: ConnectDevice) => {
    try {
      await invoke("tidal_connect_select_device", {
        deviceId: device.id,
      });
      setActiveDevice(device);
      setIsOpen(false);
      if (currentTrack && isPlaying) {
        playTrack(currentTrack, { skipHistoryPush: true });
      }
    } catch (err) {
      console.error("Failed to select device:", err);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-xs select-none">
      <div className="w-[380px] bg-th-elevated border border-th-border-subtle rounded-xl shadow-2xl overflow-hidden p-5 animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-th-border-subtle">
          <div className="flex items-center gap-2">
            <Cast size={18} className="text-th-accent" />
            <h2 className="text-sm font-semibold text-th-text-primary">
              Connect to a Device
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={refreshDevices}
              className={`p-1 text-th-text-faint hover:text-th-text-primary rounded-md transition-colors ${
                isScanning ? "animate-spin text-th-accent" : ""
              }`}
              title="Refresh devices"
            >
              <RefreshCw size={14} />
            </button>
            <button
              onClick={() => setIsOpen(false)}
              className="p-1 text-th-text-faint hover:text-th-text-primary rounded-md transition-colors"
              title="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Device List */}
        <div className="mt-3 space-y-1.5 max-h-[280px] overflow-y-auto pr-1">
          {devices.map((device) => {
            const isSelected = activeDevice.id === device.id;
            return (
              <button
                key={device.id}
                onClick={() => handleSelect(device)}
                className={`w-full text-left p-3 rounded-lg flex items-center justify-between transition-colors border ${
                  isSelected
                    ? "bg-th-surface-hover border-th-accent/50 text-th-text-primary"
                    : "bg-th-surface hover:bg-th-surface-hover border-transparent text-th-text-secondary"
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`p-2 rounded-md ${
                      isSelected
                        ? "text-th-accent bg-th-accent/10"
                        : "text-th-text-faint bg-th-elevated"
                    }`}
                  >
                    {device.isLocal ? (
                      <Laptop size={16} />
                    ) : (
                      <Radio size={16} />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-medium truncate text-th-text-primary">
                      {device.name}
                    </div>
                    <div className="text-[11px] text-th-text-faint truncate">
                      {device.modelName}
                      {!device.isLocal && ` (${device.host})`}
                    </div>
                  </div>
                </div>

                {isSelected && (
                  <div className="flex items-center gap-1 text-[11px] font-medium text-th-accent">
                    <Check size={14} />
                    <span>Listening</span>
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Footer info */}
        <div className="mt-4 pt-3 border-t border-th-border-subtle text-[11px] text-th-text-faint flex items-center justify-between">
          <span>TIDAL Connect Network Protocol</span>
          <span className="font-mono text-[10px]">mdns-sd</span>
        </div>
      </div>
    </div>
  );
});

export default TidalConnectModal;
