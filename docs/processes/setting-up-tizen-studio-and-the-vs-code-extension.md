# Setting up Tizen Studio and the VS Code extension

The **Player** is a Tizen web app (ADR 0005), and Samsung's tools build, sign,
install and run it: on a real TV, on Samsung's **TV Emulator**, or in the
**TV Web Simulator**. This page says how to set those tools up on Windows,
macOS and Linux. [Installing the Player with Tizen Studio](./installing-the-player-with-tizen-studio.md)
says what to do with them once they are.

There are two ways to get them. Either will do; most people need only one.

|            | Tizen Studio                                                                                                  | VS Code extension                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| What it is | Samsung's Eclipse-based IDE, with a Package Manager, Device Manager, Certificate Manager and Emulator Manager | Samsung's **Tizen Extension** for VS Code, ID `tizen.vscode-tizen-csharp`, despite the name for web apps too |
| SDK        | Installed by its own installer                                                                                | Downloaded and managed by the extension itself, the first time it needs it                                   |
| Best for   | Following the [installing](./installing-the-player-with-tizen-studio.md) page as written                      | Working in the editor you already use                                                                        |

The extension's ID says `csharp`, but it is the current one for every kind of
Tizen app. Don't confuse it with the older **Tizen TV** extension,
`tizensdk.tizentv`, which it replaces.

**Never commit a certificate, its password or its backup** to this repository,
nor paste one into an issue, a prompt or a log.

---

## What you need on every OS

- This repository checked out, with Node and pnpm (see the [getting started guide](../guides/getting-started.md)).
- A **Samsung account**, for the signing certificate. Since TV Extension
  7.0.1, the TV Emulator, like a real TV, installs only apps signed with a
  Samsung certificate.
- **Java 8 or later**, for Tizen Studio. The VS Code extension brings what it
  needs.
- At least 4 GB of RAM and 6 GB of free disk.
- For the **TV Emulator** only: a CPU with hardware virtualisation (Intel VT-x,
  or AMD-V on Linux), switched on in the BIOS or UEFI, and the hypervisor for
  your OS below. The emulator is a QEMU virtual machine, so it won't run inside
  another one: not in VirtualBox, VMware or Parallels, nor over Remote Desktop.

---

## 1. Install Tizen Studio

Skip this if you only want the VS Code extension: go to [step 2](#2-install-the-vs-code-extension).

Samsung's installers are in [download.tizen.org/sdk/Installer](https://download.tizen.org/sdk/Installer/),
one directory per version, e.g. `tizen-studio_6.1/`. Take the **Tizen Studio
with IDE** (`web-ide_…`) installer for your OS from the newest one.

### Windows

1. Run the `.exe` installer, accept the licence and keep the default location,
   `C:\tizen-studio`, with its data in `C:\tizen-studio-data`.
2. Tick **Launch the Package Manager** before choosing **Finish**.

### macOS

1. Open the `.dmg` installer and run the installer inside it. It installs to
   `~/tizen-studio` by default.
2. Tick **Launch the Package Manager** before choosing **Finish**.

Tizen Studio's emulator needs an **Intel** Mac. On Apple Silicon, use the VS
Code extension's emulator if it offers you one, or a real TV.

### Linux

Samsung supports **Ubuntu** (64-bit). Install as yourself, not as root:

```bash
chmod +x web-ide_Tizen_Studio_*_ubuntu-64.bin
./web-ide_Tizen_Studio_*_ubuntu-64.bin
```

It installs to `~/tizen-studio` by default. If it says packages are missing,
install them with `apt` and run it again.

### Then, on every OS: the TV packages

In the **Package Manager**, which the installer opens at the end, or Tizen
Studio's **Tools** menu, or `<tizen-studio>/package-manager/`:

1. On **Main SDK**, install **Tizen SDK tools**.
2. On **Extension SDK**, install the newest **TV Extensions** and the **Samsung
   Certificate Extension**, version 2.0.73 or later. Samsung says older ones
   can't make certificates after September 2025.

The command-line tools then are:

- `tizen`: `<tizen-studio>/tools/ide/bin/tizen` (`tizen.bat` on Windows).
- `sdb`: `<tizen-studio>/tools/sdb` (`sdb.exe` on Windows).

Put both directories on your `PATH` to use them as below, and for the Hub's
`pnpm start` (see the [getting started guide](../guides/getting-started.md)).

---

## 2. Install the VS Code extension

The same on every OS. In VS Code, open **Extensions** (Ctrl+Shift+X, or
Cmd+Shift+X on macOS), search for **Tizen Extension** by **Tizen**, and
install it. Or, from a terminal:

```bash
code --install-extension tizen.vscode-tizen-csharp
```

It needs no SDK installed first. It adds a **Tizen** icon to the Activity Bar,
whose **Actions** list is where most of what follows starts, and its commands
are in the Command Palette (Ctrl+Shift+P, or Cmd+Shift+P) under **Tizen:**.

- **Tizen: Install Tizen CLI** installs the `tizen` command-line tool, to use as
  in [step 5](#5-install-and-run-the-player).
- **Tizen: Set SDK Path** points it at a Tizen Studio you have already
  installed, rather than having it download its own.
- **Tizen: Package Manager** installs further SDK packages, as Tizen Studio's
  does.

---

## 3. Turn on your OS's hypervisor, for the TV Emulator

Skip this if you won't use the emulator.

### Windows

The emulator uses either the **Windows Hypervisor Platform** (WHPX) or
**Intel HAXM**, never both:

- **WHPX** works alongside Hyper-V, and so alongside WSL 2 and Docker Desktop.
  Use it if you have either. In an administrator PowerShell, then restart:

  ```powershell
  Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All
  ```

- **Intel HAXM** needs an Intel CPU and **Hyper-V switched off**, which stops
  WSL 2 and Docker Desktop from running while it is. Intel no longer develops
  HAXM; use it only if the emulator won't start with WHPX, as older emulator
  images don't. Turn Hyper-V off in **Turn Windows features on or off**,
  restart, then install HAXM from [Intel's releases](https://github.com/intel/haxm/releases)
  by running its `silent_install.bat` as administrator.

### macOS

Intel Macs use macOS's own Hypervisor framework, with nothing to install. On
Apple Silicon, Tizen Studio has no emulator. The VS Code extension has one only
for some images; if **Create Emulator** offers none, use the TV Web Simulator
or a real TV.

### Linux

The emulator uses **KVM**. Check that it is there and that you may use it:

```bash
ls -l /dev/kvm            # exists if the CPU's virtualisation is on and KVM is loaded
sudo apt install qemu-kvm  # if it doesn't
sudo usermod -aG kvm "$USER"  # then sign out and in again
```

---

## 4. Make a Samsung TV certificate

A TV, or the emulator, installs only an app signed with a Samsung certificate
whose distributor half lists that TV's DUID. Connect the TV, or start the
emulator ([step 6](#6-the-tv-emulator)), first, so that its DUID can be read.

- **Tizen Studio:** as in [step 4 of the installing page](./installing-the-player-with-tizen-studio.md#4-make-a-signing-certificate-for-the-tv).
- **VS Code:** run **Tizen: Create Certificate**, choose **Samsung**, then
  **TV**, sign in with your Samsung account, and check that the TV's or the
  emulator's DUID is in the list.

Either keeps the certificate in `SamsungCertificate/<profile>/` in your home
folder, outside the repository, where it stays. To use one certificate for the
emulator and real TVs alike, list all their DUIDs in its distributor
certificate.

---

## 5. Install and run the Player

Build it, then package, install and run it with the `tizen` tool, from Tizen
Studio or the VS Code extension:

```bash
pnpm install
pnpm --filter @media-centre/player build
tizen package -t wgt -s <profile> -- packages/player/dist
tizen install -n "Media Centre.wgt" -- packages/player/dist
tizen run -p MediaCntre.Player
```

With one TV or emulator connected, `tizen` uses it. With more, pick one with
`-s`, as `sdb devices` lists it. The [installing page](./installing-the-player-with-tizen-studio.md)
explains each step, and what to do when one fails.

In VS Code, **Tizen: Import WGT as Web Project** turns the signed `.wgt` into
a project that **Tizen: Run Project** and **Tizen: Debug Project** work on;
**Debug Project** opens the Player with the Web Inspector.

---

## 6. The TV Emulator

A virtual TV that runs Samsung's own TV software, on your PC.

1. **Create one.** In Tizen Studio, **Tools → Emulator Manager → Create**; in VS
   Code, **Actions → Create Emulator**. Choose the **TV** image, then a TV
   template.
2. **Check its settings.** **RAM** of 1024 MB or more, and on **HW Support**,
   **CPU VT** and **GPU** both **ON**: it won't start if either is off. A
   warning beside CPU VT means it found no hypervisor ([step 3](#3-turn-on-your-oss-hypervisor-for-the-tv-emulator)).
3. **Start it.** In Tizen Studio, **Launch**; in VS Code, select it in the
   **Emulator Manager** list, on the **Tizen** tab beside the Terminal, and
   **Start**. `sdb devices` then lists it.
4. Make the certificate ([step 4](#4-make-a-samsung-tv-certificate)), then
   install the Player ([step 5](#5-install-and-run-the-player)).

**Choose the oldest TV image you can.** The Player targets the 2018 TVs' Tizen
4, whose web engine is Chromium 56. The newest image, TV 10.0, runs Chromium
130, so the Player can work there and still fail on a TV. The build's
`es-check` catches newer JavaScript, but not newer CSS or DOM.

### What the emulator can't prove

- **Playback.** It plays no 4K and no DRM, and expect AVPlay to play little
  beyond H.264 and AAC. MKV, HEVC and AC3 need a real TV (ADR 0005).
- **The Hub driving it.** It isn't a whole Samsung TV, and probably hasn't the
  TV's remote-control socket the Samsung TV Driver uses to power it, press its
  keys and launch the Player with the Hub's address. Launch the Player by hand,
  as in step 5: it waits for the Remote until it has an address.
- **Long-presses** of the remote's keys, and **secure WebSockets**.

So it complements, and doesn't replace, the PRD's manual checklist on a real TV
(ADR 0004).

---

## 7. The TV Web Simulator

Lighter than the emulator: a browser page that fakes the TV's APIs in
JavaScript, rather than running Samsung's TV software. It needs no hypervisor,
so it runs anywhere VS Code does, Apple Silicon included. In VS Code,
right-click the project and choose **Tizen: Run as TV Web Simulator
Application**; **Tizen: Set Chrome Path** tells it where Chrome is if it can't
find it.

Use it to look at the Player's screens and try its remote keys. What it plays,
it plays through Chrome, not the TV's media player, so it proves nothing about
playback. For the screens alone, the Player in a desktop browser does as well:
it plays through its fake playback, and takes the Hub's address as
`?hub=<ip>:<port>`.

---

## When it goes wrong

| What you see                                                    | What to do                                                                                                                                                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The emulator won't start, or a warning beside **CPU VT**        | Switch on the CPU's virtualisation in the BIOS or UEFI, and the hypervisor for your OS ([step 3](#3-turn-on-your-oss-hypervisor-for-the-tv-emulator)). Check **CPU VT** and **GPU** are **ON**. |
| `-enable-whpx: invalid option` on Windows                       | That emulator image predates WHPX. Update the TV Extensions and make a new emulator, or use HAXM with Hyper-V off.                                                                              |
| The emulator stops at "booting the kernel"                      | Its hardware acceleration isn't working: as the first row.                                                                                                                                      |
| The emulator crashes or draws nothing                           | Update the graphics driver. On a laptop with two GPUs, run it on the better one.                                                                                                                |
| The emulator won't install the Player, with a certificate error | It needs a Samsung certificate, not a Tizen one, listing the emulator's DUID ([step 4](#4-make-a-samsung-tv-certificate)).                                                                      |
| The Certificate Manager can't make a certificate                | Update the Samsung Certificate Extension to 2.0.73 or later.                                                                                                                                    |
| `tizen` or `sdb` isn't found                                    | Put their directories on your `PATH` ([step 1](#then-on-every-os-the-tv-packages)), or use **Tizen: Install Tizen CLI**.                                                                        |
| On Linux, `/dev/kvm` is missing or permission is denied         | Install KVM and join the `kvm` group ([step 3](#linux)), then sign out and in.                                                                                                                  |
