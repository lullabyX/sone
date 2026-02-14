import { memo, useState } from "react";
import { ListMusic, Play } from "lucide-react";

interface TidalImageProps {
  src: string | undefined;
  alt: string;
  className?: string;
  type?: "album" | "playlist";
}

function TidalImageComponent({
  src,
  alt,
  className = "",
  type = "album",
}: TidalImageProps) {
  const [hasError, setHasError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  if (!src || hasError) {
    return (
      <div
        className={`bg-gradient-to-br from-th-button to-th-surface flex items-center justify-center ${className}`}
      >
        {type === "playlist" ? (
          <Play size={24} className="text-gray-600" />
        ) : (
          <ListMusic size={24} className="text-gray-600" />
        )}
      </div>
    );
  }

  return (
    <div className={`relative ${className}`}>
      {isLoading && (
        <div className="absolute inset-0 bg-th-surface-hover animate-pulse" />
      )}
      <img
        src={src}
        alt={alt}
        className={`w-full h-full object-cover ${
          isLoading ? "opacity-0" : "opacity-100"
        } transition-opacity`}
        onError={() => setHasError(true)}
        onLoad={() => setIsLoading(false)}
        loading="lazy"
      />
    </div>
  );
}

const TidalImage = memo(TidalImageComponent);
TidalImage.displayName = "TidalImage";

export default TidalImage;
