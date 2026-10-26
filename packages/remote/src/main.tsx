import { render } from "preact";

import { createAmazonApi } from "./amazon-api.ts";
import { App } from "./app.tsx";
import { createAppliancesApi } from "./appliances-api.ts";
import { createHubAddressApi } from "./hub-address-api.ts";
import { checkHub } from "./hub-status.ts";
import { checkLatestVersion } from "./latest-version.ts";
import { createMediaSourcesApi } from "./media-sources-api.ts";
import { createNetworkApi } from "./network-api.ts";
import { createRingApi } from "./ring-api.ts";
import { createRoomsApi } from "./rooms-api.ts";
import { createSigningCertificateApi } from "./signing-certificate-api.ts";

const root = document.querySelector("#remote");
if (root) {
  render(
    <App
      storage={localStorage}
      loadHubStatus={checkHub}
      loadLatestVersion={checkLatestVersion}
      rooms={createRoomsApi()}
      appliances={createAppliancesApi()}
      hubAddress={createHubAddressApi()}
      mediaSources={createMediaSourcesApi()}
      signingCertificate={createSigningCertificateApi()}
      network={createNetworkApi()}
      amazon={createAmazonApi()}
      ring={createRingApi()}
    />,
    root,
  );
}
