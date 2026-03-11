export const SORT_OPTIONS: Record<"albums" | "artists" | "mixes", { value: string; label: string }[]> = {
  albums: [
    { value: "DATE", label: "Date added" },
    { value: "NAME", label: "Name" },
    { value: "ARTIST", label: "Artist" },
    { value: "RELEASE_DATE", label: "Release date" },
  ],
  artists: [
    { value: "DATE", label: "Date added" },
    { value: "NAME", label: "Name" },
  ],
  mixes: [
    { value: "DATE", label: "Date added" },
    { value: "NAME", label: "Name" },
    { value: "MIX_TYPE", label: "Type" },
  ],
};
