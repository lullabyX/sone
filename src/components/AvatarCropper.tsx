import { useCallback, useState } from "react";
import Cropper, { type Area } from "react-easy-crop";
import { X, ZoomIn } from "lucide-react";
import { getCroppedBlob, blobToBase64 } from "../lib/cropImage";

interface AvatarCropperProps {
  imageSrc: string;
  onCancel: () => void;
  onConfirm: (base64Jpeg: string) => void;
}

export default function AvatarCropper({
  imageSrc,
  onCancel,
  onConfirm,
}: AvatarCropperProps) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [areaPixels, setAreaPixels] = useState<Area | null>(null);
  const [busy, setBusy] = useState(false);

  const onCropComplete = useCallback((_: Area, pixels: Area) => {
    setAreaPixels(pixels);
  }, []);

  const handleSet = async () => {
    if (!areaPixels) return;
    setBusy(true);
    try {
      const blob = await getCroppedBlob(imageSrc, areaPixels);
      const base64 = await blobToBase64(blob);
      onConfirm(base64);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-[520px] max-w-[94vw] bg-th-elevated rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-th-border-subtle">
          <h3 className="text-[16px] font-bold text-th-text-primary">
            Crop photo
          </h3>
          <button
            onClick={onCancel}
            aria-label="Close"
            className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-th-inset text-th-text-muted hover:text-th-text-primary transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4">
          <p className="text-[12px] text-th-text-muted mb-3">
            TIDAL requires a square photo. Drag to reposition, then zoom to frame
            it.
          </p>
          <div className="relative w-full aspect-square bg-black rounded-lg overflow-hidden">
            <Cropper
              image={imageSrc}
              crop={crop}
              zoom={zoom}
              aspect={1}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={onCropComplete}
            />
          </div>
          <div className="flex items-center gap-3 mt-4">
            <ZoomIn size={16} className="text-th-text-muted" />
            <input
              type="range"
              min={1}
              max={3}
              step={0.01}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              aria-label="Zoom"
              className="flex-1 accent-th-accent"
            />
          </div>
        </div>

        <div className="px-5 py-3 border-t border-th-border-subtle flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-5 py-2 rounded-full text-sm font-semibold text-th-text-secondary hover:text-th-text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSet}
            disabled={!areaPixels || busy}
            className="px-6 py-2 bg-th-accent text-th-on-accent rounded-full text-sm font-bold hover:scale-105 transition-transform disabled:opacity-40 disabled:hover:scale-100"
          >
            {busy ? "Working…" : "Set photo"}
          </button>
        </div>
      </div>
    </div>
  );
}
