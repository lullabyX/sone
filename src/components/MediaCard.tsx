import { Play, User, Music } from "lucide-react";
import { getItemImage, getItemTitle, getItemSubtitle } from "../utils/itemHelpers";

interface MediaCardProps {
  item: any;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  isArtist?: boolean;
  showPlayButton?: boolean;
  /** Card width class — defaults to full-width (grid-controlled). Use "w-[180px] flex-shrink-0" for horizontal scroll rows. */
  widthClass?: string;
}

export default function MediaCard({
  item,
  onClick,
  onContextMenu,
  isArtist = false,
  showPlayButton = true,
  widthClass,
}: MediaCardProps) {
  const image = getItemImage(item);
  const title = getItemTitle(item);
  const subtitle = getItemSubtitle(item);

  return (
    <div
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`p-3 bg-th-elevated hover:bg-th-surface-hover rounded-lg cursor-pointer group transition-[background-color] duration-300 ${widthClass ?? ""}`}
    >
      {/* Image */}
      <div
        className={`w-full aspect-square mb-3 relative overflow-hidden shadow-lg bg-th-surface-hover ${
          isArtist ? "rounded-full" : "rounded-md"
        }`}
      >
        {image ? (
          <img
            src={image}
            alt={title}
            className="w-full h-full object-cover transform group-hover:scale-105 transition-transform duration-500 ease-out"
            loading="lazy"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-th-button to-th-surface">
            {isArtist ? (
              <User size={40} className="text-gray-600" />
            ) : (
              <Music size={40} className="text-gray-600" />
            )}
          </div>
        )}
        {showPlayButton && !isArtist && (
          <>
            <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClick();
              }}
              className="absolute bottom-2 right-2 w-10 h-10 bg-th-accent rounded-full flex items-center justify-center shadow-xl opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 transition-[opacity,transform] duration-300 scale-90 group-hover:scale-100 hover:scale-110"
            >
              <Play size={20} fill="black" className="text-black ml-1" />
            </button>
          </>
        )}
      </div>
      {/* Title */}
      <h4
        className={`font-bold text-[14px] text-white truncate mb-1 ${
          isArtist ? "text-center" : ""
        }`}
      >
        {title}
      </h4>
      {/* Subtitle */}
      {subtitle && (
        <p
          className={`text-[12px] text-th-text-muted line-clamp-2 ${
            isArtist ? "text-center" : ""
          }`}
        >
          {subtitle}
        </p>
      )}
    </div>
  );
}
