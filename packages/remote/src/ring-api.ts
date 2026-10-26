import {
  RING_CODE_PATH,
  RING_PATH,
  RING_SIGN_IN_PATH,
  ringDeviceActionsPath,
  ringDevicePath,
  ringDeviceRoomPath,
  ringLiveViewPath,
  ringLiveViewSessionPath,
  ringRecordingPath,
  ringSnapshotPath,
  type NetworkDeviceRoomRequest,
  type RingAction,
  type RingCodeRequest,
  type RingDeviceState,
  type RingHome,
  type RingLiveView,
  type RingLiveViewRequest,
  type RingRecording,
  type RingSignInRequest,
} from "@media-centre/shared";

import { createHubRequest } from "./hub-request.ts";

/** The owner's Ring devices, through the Hub's sign-in to Ring (ADR 0014), for the Ring tab. */
export interface RingApi {
  readonly home: () => Promise<RingHome>;
  /** Signs in; the status then may ask for the two-step code Ring sent. */
  readonly signIn: (email: string, password: string) => Promise<RingHome>;
  readonly enterCode: (code: string) => Promise<RingHome>;
  readonly signOut: () => Promise<RingHome>;
  readonly state: (id: string) => Promise<RingDeviceState>;
  readonly act: (id: string, action: RingAction) => Promise<RingDeviceState>;
  /** Where the camera's latest snapshot is, fresh each time it is asked. */
  readonly snapshotUrl: (id: string) => string;
  /** Hands Ring the browser's WebRTC offer through the Hub, and answers with Ring's. */
  readonly startLiveView: (id: string, sdp: string) => Promise<RingLiveView>;
  readonly endLiveView: (id: string, sessionId: string) => Promise<void>;
  readonly recording: (id: string, eventId: string) => Promise<RingRecording>;
  readonly setRoom: (id: string, roomId: number | null) => Promise<RingHome>;
}

/** Talks to the Hub about Ring. A refusal, Ring's too, fails with a `HubRequestFailed` giving why. */
export const createRingApi = (fetchFn: typeof fetch = fetch): RingApi => {
  const request = createHubRequest(fetchFn);
  const answer = async <T>(response: Promise<Response>): Promise<T> => (await (await response).json()) as T;

  return {
    home: () => answer(request("GET", RING_PATH)),
    signIn: (email, password) => {
      const body: RingSignInRequest = { email, password };
      return answer(request("POST", RING_SIGN_IN_PATH, body));
    },
    enterCode: (code) => {
      const body: RingCodeRequest = { code };
      return answer(request("POST", RING_CODE_PATH, body));
    },
    signOut: () => answer(request("DELETE", RING_SIGN_IN_PATH)),
    state: (id) => answer(request("GET", ringDevicePath(id))),
    act: (id, action) => answer(request("POST", ringDeviceActionsPath(id), action)),
    snapshotUrl: (id) => `${ringSnapshotPath(id)}?at=${String(Date.now())}`,
    startLiveView: (id, sdp) => {
      const body: RingLiveViewRequest = { sdp };
      return answer(request("POST", ringLiveViewPath(id), body));
    },
    endLiveView: async (id, sessionId) => {
      await request("DELETE", ringLiveViewSessionPath(id, sessionId));
    },
    recording: (id, eventId) => answer(request("GET", ringRecordingPath(id, eventId))),
    setRoom: (id, roomId) => {
      const body: NetworkDeviceRoomRequest = { roomId };
      return answer(request("PUT", ringDeviceRoomPath(id), body));
    },
  };
};
