import { memo } from "react";
import { Cast } from "lucide-react";
import { useAtom, useAtomValue } from "jotai";
import {
  activeDeviceAtom,
  isConnectModalOpenAtom,
} from "../atoms/tidalConnect";

export const TidalConnectButton = memo(function TidalConnectButton() {
  const activeDevice = useAtomValue(activeDeviceAtom);
  const [modalOpen, setModalOpen] = useAtom(isConnectModalOpenAtom);
  const isCasting = !activeDevice.isLocal;

  return (
    <button
      onClick={() => setModalOpen(!modalOpen)}
      className={`transition-colors duration-150 flex items-center gap-1.5 p-1 rounded-md ${
        isCasting
          ? "text-th-accent bg-th-accent/10"
          : modalOpen
          ? "text-th-accent"
          : "text-th-text-faint hover:text-th-text-primary"
      }`}
      title={
        isCasting
          ? `TIDAL Connect: Casting to ${activeDevice.name}`
          : "TIDAL Connect: Cast to device"
      }
    >
      <Cast size={16} strokeWidth={2} />
      {isCasting && (
        <span className="text-[11px] font-medium text-th-accent max-w-[90px] truncate">
          {activeDevice.name}
        </span>
      )}
    </button>
  );
});

export default TidalConnectButton;
