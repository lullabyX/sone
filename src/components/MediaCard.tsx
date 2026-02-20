import { Play, User, Music, Heart, MoreHorizontal } from "lucide-react";
import {
  getItemImage,
  getItemTitle,
  getItemSubtitle,
} from "../utils/itemHelpers";

interface MediaCardProps {
  item: any;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onPlay?: (e: React.MouseEvent) => void;
  onMoreClick?: (e: React.MouseEvent) => void;
  isFavorited?: boolean;
  onFavoriteToggle?: (e: React.MouseEvent) => void;
  isArtist?: boolean;
  showPlayButton?: boolean;
  /** Card width class — defaults to full-width (grid-controlled). Use "w-[180px] flex-shrink-0" for horizontal scroll rows. */
  widthClass?: string;
}

export default function MediaCard({
  item,
  onClick,
  onContextMenu,
  onPlay,
  onMoreClick,
  isFavorited,
  onFavoriteToggle,
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
      className={`p-3 bg-th-elevated hover:bg-th-surface-hover rounded-lg cursor-pointer group transition-[background-color] duration-300 ${
        widthClass ?? ""
      }`}
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
        {showPlayButton && (
          <>
            {isArtist ? (
              /* Artist: full dark overlay with centered white play icon */
              <div
                className="absolute inset-0 rounded-full bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300 cursor-pointer hover:bg-black/50"
                onClick={(e) => {
                  e.stopPropagation();
                  if (onPlay) onPlay(e);
                  else onClick();
                }}
              >
                <Play size={28} fill="white" className="text-white ml-0.5 transition-transform duration-200 hover:scale-110" />
              </div>
            ) : (
              <>
                <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                {/* Play button — bottom-left */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (onPlay) onPlay(e);
                    else onClick();
                  }}
                  className="absolute bottom-2 left-2 w-10 h-10 bg-th-accent rounded-full flex items-center justify-center shadow-xl opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 transition-all duration-300 ease-out hover:brightness-110 hover:scale-110 hover:shadow-2xl"
                >
                  <Play size={20} fill="black" className="text-black ml-0.5" />
                </button>
              </>
            )}
            {/* Right side icons — non-artist only */}
            {!isArtist && (
              <div className="absolute bottom-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 transition-[opacity,transform,translate] duration-300">
                {onMoreClick && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onMoreClick(e);
                    }}
                    className="w-8 h-8 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center hover:bg-black/70 transition-colors"
                  >
                    <MoreHorizontal size={16} className="text-white" />
                  </button>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (onFavoriteToggle) onFavoriteToggle(e);
                  }}
                  className="w-8 h-8 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center hover:bg-black/70 transition-colors"
                >
                  <Heart
                    size={16}
                    className={isFavorited ? "text-th-accent" : "text-white"}
                    fill={isFavorited ? "currentColor" : "none"}
                    strokeWidth={isFavorited ? 0 : 2}
                  />
                </button>
              </div>
            )}
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
