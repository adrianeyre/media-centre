import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import { SigningCertificateSetting } from "./signing-certificate-setting.tsx";
import { fakeSigningCertificateApi, type FakeSigningCertificateApi } from "./testing/fake-signing-certificate-api.ts";

afterEach(cleanup);

const AUTHOR = new Uint8Array([0x30, 0x82, 0x01, 0xff]);
const DISTRIBUTOR = new Uint8Array([0x30, 0x82, 0x02, 0x00]);

const setting = () => screen.getByRole("region", { name: "Signing certificate" });
const form = () => within(setting()).getByRole("form", { name: "Store a signing certificate" });
const field = (label: string) => within(form()).getByLabelText<HTMLInputElement>(label);

const renderSetting = (signingCertificate: FakeSigningCertificateApi = fakeSigningCertificateApi()) => {
  render(<SigningCertificateSetting signingCertificate={signingCertificate} />);
  return signingCertificate;
};

const choose = (label: string, bytes: Uint8Array<ArrayBuffer>, name: string) => {
  const input = field(label);
  Object.defineProperty(input, "files", { configurable: true, value: [new File([bytes], name)] });
  fireEvent.change(input);
};

const type = (label: string, text: string) => {
  fireEvent.input(field(label), { target: { value: text } });
};

const store = () => {
  fireEvent.click(within(form()).getByRole("button", { name: "Store signing certificate" }));
};

describe("Settings' signing certificate (FR-31)", () => {
  it("says when the Hub has none, which it needs to install the Player", async () => {
    renderSetting();

    await waitFor(() => {
      expect(setting().textContent).toContain(
        "The Hub has no signing certificate yet. It needs one to install the Player on a TV.",
      );
    });
    expect(within(setting()).queryByRole("button", { name: "Remove signing certificate" })).toBeNull();
  });

  it("sends the Hub both files and their passwords, then forgets the passwords", async () => {
    const signingCertificate = renderSetting();
    await waitFor(() => {
      expect(setting().textContent).toContain("no signing certificate yet");
    });

    choose("Author certificate (author.p12)", AUTHOR, "author.p12");
    type("Author certificate's password", "author-pass");
    choose("Distributor certificate (distributor.p12)", DISTRIBUTOR, "distributor.p12");
    type("Distributor certificate's password", "distributor-pass");
    store();

    await waitFor(() => {
      expect(setting().textContent).toContain("The Hub has a signing certificate, stored on");
    });
    expect(signingCertificate.stored).toEqual([
      {
        author: btoa(String.fromCharCode(...AUTHOR)),
        authorPassword: "author-pass",
        distributor: btoa(String.fromCharCode(...DISTRIBUTOR)),
        distributorPassword: "distributor-pass",
      },
    ]);
    expect(field("Author certificate's password").value).toBe("");
    expect(field("Distributor certificate's password").value).toBe("");
    expect(field("Author certificate's password").type).toBe("password");
    expect(within(setting()).getByRole("heading", { name: "Replace it" })).toBeTruthy();
  });

  it("leaves the distributor's password to the Hub to take as the author's when it is left empty", async () => {
    const signingCertificate = renderSetting();

    choose("Author certificate (author.p12)", AUTHOR, "author.p12");
    type("Author certificate's password", "one-password");
    choose("Distributor certificate (distributor.p12)", DISTRIBUTOR, "distributor.p12");
    store();

    await waitFor(() => {
      expect(signingCertificate.stored).toHaveLength(1);
    });
    expect(signingCertificate.stored[0]?.distributorPassword).toBeNull();
  });

  it("asks for both files before sending anything", async () => {
    const signingCertificate = renderSetting();

    choose("Author certificate (author.p12)", AUTHOR, "author.p12");
    type("Author certificate's password", "author-pass");
    store();

    await waitFor(() => {
      expect(within(setting()).getByRole("alert").textContent).toBe(
        "Choose both the author certificate and the distributor certificate.",
      );
    });
    expect(signingCertificate.stored).toEqual([]);
  });

  it("shows why the Hub refused it", async () => {
    const signingCertificate = renderSetting();
    signingCertificate.refuseNext("The author certificate isn't a .p12 file. Choose the one Tizen Studio made.");

    choose("Author certificate (author.p12)", AUTHOR, "author.p12");
    type("Author certificate's password", "author-pass");
    choose("Distributor certificate (distributor.p12)", DISTRIBUTOR, "distributor.p12");
    store();

    await waitFor(() => {
      expect(within(setting()).getByRole("alert").textContent).toBe(
        "The author certificate isn't a .p12 file. Choose the one Tizen Studio made.",
      );
    });
    expect(field("Author certificate's password").value).toBe("author-pass");
  });

  it("removes the one the Hub has, once the person says so", async () => {
    renderSetting(fakeSigningCertificateApi({ stored: true, storedAt: "2026-10-20T08:00:00.000Z" }));
    await waitFor(() => {
      expect(setting().textContent).toContain("The Hub has a signing certificate, stored on");
    });

    fireEvent.click(within(setting()).getByRole("button", { name: "Remove signing certificate" }));
    fireEvent.click(within(setting()).getByRole("button", { name: "No, keep it" }));
    fireEvent.click(within(setting()).getByRole("button", { name: "Remove signing certificate" }));
    fireEvent.click(within(setting()).getByRole("button", { name: "Yes, remove" }));

    await waitFor(() => {
      expect(setting().textContent).toContain("The Hub has no signing certificate yet.");
    });
  });
});
