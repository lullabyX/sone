import { QRCodeSVG } from "qrcode.react";

export function TvQrCode({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="img"
      aria-label={label}
      className="shrink-0 rounded-[1.2rem] bg-white p-[1.2rem]"
    >
      <QRCodeSVG
        value={value}
        level="M"
        aria-hidden
        className={`block ${className ?? ""}`}
      />
    </div>
  );
}
