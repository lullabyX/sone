/** Shared handle to the live <video> element owned by VideoPlayer, so the
 *  PlayerBar can drive playback/seek while the overlay is minimized. */
export const videoElementRef: { current: HTMLVideoElement | null } = {
  current: null,
};
