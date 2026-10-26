import { access } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import {
  APPLIANCES_PATH,
  type Appliance,
  type DeviceInfo,
  type PlayerAction,
  type PlayerActionProgress,
  type PlayerActionStep,
} from "@media-centre/shared";

import { ApplianceRefusal, type ApplianceStore } from "./appliances.ts";
import { DriverFailure, type Drivers, type SigningCertificate } from "./drivers/driver.ts";
import { HttpRefusal, readJson, refuseMethod } from "./http.ts";
import type { HubAddressStore } from "./hub-address.ts";
import type { SigningCertificateStore } from "./signing-certificates.ts";

const PLAYER_PATH = new RegExp(`^${APPLIANCES_PATH}/([1-9][0-9]{0,15})/player/action$`);

const ACTIONS: readonly PlayerAction[] = ["install", "launch", "uninstall"];

/** What each action is, for the Hub's log, as "Installed the Player on …" says it. */
const DONE: Readonly<Record<PlayerAction, string>> = {
  install: "Installed",
  launch: "Launched",
  uninstall: "Uninstalled",
};

export interface PlayerToolsDependencies {
  readonly appliances: ApplianceStore;
  readonly drivers: Drivers;
  readonly hubAddress: HubAddressStore;
  readonly signingCertificate: SigningCertificateStore;
  /** The folder of the Player build the Hub installs, `packages/player/dist`. */
  readonly playerDir: string;
}

/** Hides each of the signing certificate's passwords in what the Hub says, should a tool ever have repeated one. */
const withoutPasswords = (text: string, certificate: SigningCertificate | null): string =>
  certificate === null
    ? text
    : [certificate.authorPassword, certificate.distributorPassword]
        .filter((password) => password !== "")
        .reduce((hidden, password) => hidden.replaceAll(password, "********"), text);

/**
 * Installs or updates, launches and uninstalls the Player on a TV (see
 * `appliancePlayerActionPath` in `shared`), or returns false for any other path.
 * What can be refused is checked first, and refused as any request is: the
 * TV must say, now, that it is in Developer Mode with the Hub's IP as its
 * Developer IP, as the Remote shows its buttons only then (FR-31), and
 * installing needs the signing certificate and the Player build. Then each
 * step is sent as it starts, so that the Remote shows it. One TV does one at
 * a time. It is logged, as the person asked for it, but never with the
 * signing certificate or its passwords (FR-4).
 */
export const createPlayerToolsHandler = ({
  appliances,
  drivers,
  hubAddress,
  signingCertificate,
  playerDir,
}: PlayerToolsDependencies) => {
  /** The TVs doing one now, by id. */
  const busy = new Set<number>();

  return async (request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> => {
    const id = PLAYER_PATH.exec(pathname)?.[1];
    if (id === undefined) return false;
    if (request.method !== "POST") {
      refuseMethod(response, ["POST"]);
      return true;
    }
    const action = actionIn(await readJson(request));

    let appliance: Appliance;
    try {
      appliance = appliances.get(Number(id));
    } catch (error) {
      if (error instanceof ApplianceRefusal) throw new HttpRefusal(404, error.message);
      throw error;
    }
    const title = appliances.title(appliance);
    const { playerTools, readDeviceInfo } = appliance.kind === "tv" ? drivers.tv : {};
    if (playerTools === undefined || readDeviceInfo === undefined) {
      throw new HttpRefusal(400, `${title} can't have the Player installed.`);
    }
    if (busy.has(appliance.id)) {
      throw new HttpRefusal(409, `${title} is busy with the Player already. Wait until it is done, then try again.`);
    }
    busy.add(appliance.id);
    try {
      const address = hubAddress.read().address;
      if (address === null) {
        throw new HttpRefusal(
          409,
          "The Hub doesn't know its own IP address, which must be the TV's Developer IP. Set it in Settings, under Hub.",
        );
      }
      let info: DeviceInfo;
      try {
        info = await readDeviceInfo(appliance.address);
      } catch (error) {
        if (error instanceof DriverFailure) throw new HttpRefusal(502, error.message);
        throw error;
      }
      if (info.developer?.mode !== "on" || info.developer.ip !== address) {
        throw new HttpRefusal(
          409,
          `${title} isn't in Developer Mode with the Hub's IP, ${address}, as its Developer IP. Its Developer ` +
            "section says how to switch it on.",
        );
      }
      const certificate = action === "install" ? signingCertificate.read() : null;
      if (action === "install") {
        if (certificate === null) {
          throw new HttpRefusal(
            409,
            "The Hub has no signing certificate to sign the Player with. Add yours in Settings, under Signing certificate.",
          );
        }
        const built = await access(join(playerDir, "config.xml")).then(
          () => true,
          () => false,
        );
        if (!built) {
          throw new HttpRefusal(
            409,
            "The Hub has no Player build to install. Build it with `pnpm --filter @media-centre/player build`.",
          );
        }
      }

      response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
      const tell = (progress: PlayerActionProgress): void => {
        response.write(`${JSON.stringify(progress)}\n`);
      };
      const step = (each: PlayerActionStep): void => {
        tell({ step: each });
      };
      try {
        if (action === "install" && certificate !== null) {
          await playerTools.install(appliance.address, { dir: playerDir, certificate }, step);
        } else if (action === "launch") {
          await playerTools.launch(appliance.address, step);
        } else {
          await playerTools.uninstall(appliance.address, step);
        }
        console.log(`${DONE[action]} the Player on ${title}`);
        tell({ step: "done" });
      } catch (error) {
        const known = error instanceof DriverFailure;
        if (!known) console.error(`Failed to ${action} the Player on ${title}`, error);
        const message = withoutPasswords(known ? error.message : "Something went wrong. Try again.", certificate);
        console.log(`Couldn't ${action} the Player on ${title}: ${message}`);
        tell({ step: "failed", error: message });
      }
      response.end();
      return true;
    } finally {
      busy.delete(appliance.id);
    }
  };
};

/** The action a `PlayerActionRequest` asks for, which may be anything. */
const actionIn = (body: unknown): PlayerAction => {
  const action = typeof body === "object" && body !== null && "action" in body ? body.action : undefined;
  const known = ACTIONS.find((each) => each === action);
  if (known === undefined)
    throw new HttpRefusal(400, 'Say what to do with the Player: "install", "launch" or "uninstall".');
  return known;
};
