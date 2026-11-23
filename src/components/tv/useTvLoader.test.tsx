import { expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { OFFLINE_TEXT } from "./tvErrorText";
import { useTvLoader } from "./useTvLoader";

const failWith = (e: unknown) => () => Promise.reject(e);

it("offline, the error is plain words rather than the request error", async () => {
  const load = failWith({
    kind: "Network",
    message: "error sending request for url (https://api.tidal.com/v1/x)",
  });
  const { result } = renderHook(() => useTvLoader(load, "Couldn't load"));
  await waitFor(() => expect(result.current.error).toBe(OFFLINE_TEXT));
});

it("other failures keep their own message, else the screen's", async () => {
  const boom = failWith(new Error("boom"));
  const { result } = renderHook(() => useTvLoader(boom, "Couldn't load"));
  await waitFor(() => expect(result.current.error).toBe("boom"));

  const odd = failWith(42);
  const other = renderHook(() => useTvLoader(odd, "Couldn't load"));
  await waitFor(() => expect(other.result.current.error).toBe("Couldn't load"));
});
