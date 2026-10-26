# Installing the Player with Tizen Studio

The **Player** is a Tizen web app that is sideloaded onto each Samsung TV, which
needs the TV in Developer Mode (PRD §4). The Hub installs it itself, from the
TV's Developer section in the Remote (FR-31), signed with your Samsung signing
certificate, which you make once with Samsung's Tizen Studio on a PC (steps 1
to 4), then give the Hub ([Letting the Hub install it](#letting-the-hub-install-it)).

It can also be installed by hand from the PC (steps 5 to 7), as it must be
where the Hub can't: Samsung's tools that install it are in the Hub's Docker
image on amd64 only, not on an ARM NAS.

---

## What you need

- A PC on the same home network as the TV, with this repository checked out,
  Node 26 or later and pnpm 12 (see the [getting started guide](../guides/getting-started.md)).
- The TV's IP address, from the TV's network settings, or from the Hub in the
  Remote's Settings once the TV is added there.
- A **Samsung account**, to make the signing certificate. A Samsung TV installs
  only apps signed with a Samsung certificate that names that TV.
- **Tizen Studio**, below.

**Never commit a certificate, its password or its backup** to this repository,
nor paste one into an issue, a prompt or a log. Tizen Studio keeps them outside
the repository, in `SamsungCertificate/` in your home folder, and that is where
they stay.

---

## 1. Install Tizen Studio and its TV extensions

[Setting up Tizen Studio and the VS Code extension](./setting-up-tizen-studio-and-the-vs-code-extension.md)
says how on Windows, macOS and Linux, and how to use Samsung's VS Code
extension, TV Emulator and TV Web Simulator instead. In short:

1. Download Tizen Studio with IDE for your PC from Samsung's
   [TV SDK page](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html)
   and run the installer. It needs a Java runtime, which it offers to fetch.
2. Open the **Package Manager** that the installer opens at the end, or from
   Tizen Studio's **Tools** menu.
3. On **Main SDK**, install **Tizen SDK tools**.
4. On **Extension SDK**, install the newest **TV Extensions** and the **Samsung
   Certificate Extension**.

The command-line tools this page uses come with it. Below,
`<tizen-studio>` is where you installed it, by default `~/tizen-studio` on Linux
and macOS and `C:\tizen-studio` on Windows:

- `tizen` is `<tizen-studio>/tools/ide/bin/tizen` (`tizen.bat` on Windows).
- `sdb` is `<tizen-studio>/tools/sdb` (`sdb.exe` on Windows).

---

## 2. Put the TV in Developer Mode, with the PC's IP

Samsung allows this only at the TV, with its own remote (PRD §4).

1. On the TV, open **Apps**.
2. Type **1 2 3 4 5** on the remote, or on the number pad shown on screen. The
   Developer Mode dialog opens.
3. Switch **Developer mode** to **On**.
4. Enter the **PC's** IP address as the Developer IP, and choose **OK**.
5. Restart the TV: hold the remote's power button until the TV switches off
   and on again.

A TV lets only its Developer IP install apps on it, so the PC's IP is needed
for this. For the Hub to install the Player itself (FR-31), the Developer IP
must be the Hub's instead, as the Remote's Developer section says.

---

## 3. Connect Tizen Studio to the TV

1. In Tizen Studio, open **Tools → Device Manager**.
2. Choose **Remote Device Manager**, then **+**.
3. Give the TV a name, enter its IP address, keep the port at **26101**, and
   choose **Add**.
4. Switch the TV's **Connection** on. It appears in the Device Manager's list.

Or, from a terminal:

```bash
sdb connect 192.168.1.50      # the TV's IP
sdb devices                   # lists it as 192.168.1.50:26101
```

If the TV refuses, check that its Developer IP is the PC's, and that it has
been restarted since it was set.

---

## 4. Make a signing certificate for the TV

A Samsung certificate profile has two halves: an **author** certificate, which
says who wrote the app, and a **distributor** certificate, which lists the TVs
it may be installed on by each one's DUID. The TV must still be connected (step 3) so that Tizen Studio can read its DUID.

1. Open **Tools → Certificate Manager**, and choose **+**.
2. Choose **Samsung**, then **TV**.
3. Name the profile, e.g. `media-centre`.
4. Choose **Create a new author certificate**. Enter an author name and a
   password, and keep the password safe.
5. Sign in with your Samsung account when asked.
6. Choose **Create a new distributor certificate**, with the privilege level
   **Public**: the Player only asks to use the network.
7. Check that the connected TV's DUID is in the list of DUIDs, adding it if it
   isn't, then choose **Finish**.
8. Make the profile the active one, with its tick in the Certificate Manager.

Keep the author certificate. Every version of the Player must be signed with
the same one to install over the last. One signed with another must be
uninstalled first (step 7).

To install on **another TV**, connect it as in step 3, then make a new
distributor certificate in the same profile that lists the DUIDs of every TV,
keeping the author certificate as it is. If the Hub installs the Player, give
it the new distributor certificate too.

---

## Letting the Hub install it

Once the certificate lists the TV, the Hub can install the Player on it, and
update it, launch it and uninstall it, from the Remote, with no PC.

1. **Give the Hub the certificate.** In the Remote's **Settings**, under
   **Signing certificate**, choose the profile's two files, which Tizen Studio
   keeps in `SamsungCertificate/<profile>/` in your home folder: `author.p12`
   as the author certificate and `distributor.p12` as the distributor
   certificate, with the password of each, leaving the distributor's empty if
   it is the author's. Choose **Store signing certificate**. The Hub keeps
   them with the rest of its state, and never sends them or their passwords
   back, nor logs them (FR-4).
2. **Make the Hub's IP the TV's Developer IP.** A TV lets only its Developer IP
   install apps on it, so put the Hub's IP in place of the PC's, as in step 2,
   and restart the TV. The Remote's Developer section says the Hub's IP.
3. **Install it.** In the Remote's TV tab, with the TV as the Selected TV, open
   **Developer**. Once the TV says Developer Mode is on with the Hub's IP, it
   has **Install / update Player**, **Launch Player** and **Uninstall
   Player**. Install / update Player signs the Hub's own build of the Player
   with the certificate and installs it, over any Player there, showing each
   step, and why one failed if it did.

A new version of the Hub's image brings a new build of the Player: choose
Install / update Player again to update the TV.

---

## 5. Build and sign the Player

From the repository:

```bash
pnpm install
pnpm --filter @media-centre/player build
```

This writes the Player's files to `packages/player/dist/`: `index.html`, the one
script `player.js`, `style.css`, the icon and the Tizen manifest `config.xml`,
whose app id, `MediaCntre.Player`, is the one the Hub launches it by. The build
fails if the script holds anything newer than Tizen 4's web engine, Chromium 56,
can run.

Then package and sign them with the profile from step 4:

```bash
tizen package -t wgt -s media-centre -- packages/player/dist
```

It prints the path of the `.wgt` it wrote into `packages/player/dist/`, named
after the app, such as `Media Centre.wgt`. Use that name below. `dist/` is not
committed, and the next build empties it.

---

## 6. Install the Player

```bash
tizen install -s 192.168.1.50:26101 -n "Media Centre.wgt" -- packages/player/dist
```

`-s` is the TV as `sdb devices` lists it. It says **Installed the package** when
it has, and the Player, **Media Centre**, appears in the TV's **Apps**.

To install a new version, build, package and install again: it replaces the
one on the TV.

---

## 7. Check that it runs

Open **Media Centre** from the TV's **Apps**, or run it from the PC:

```bash
tizen run -s 192.168.1.50:26101 -p MediaCntre.Player
```

The Player shows **Waiting for the Remote**:

- **The first time**, it has no Hub's address yet, and says so. It is given the
  Hub's address when the Hub launches it to play a Media File (FR-35), and
  remembers it from then on (FR-39).
- **After that**, it shows the Hub's address, and below it **Connected to the
  Hub** once it has reached the Hub. If it says **Can't reach the Hub. Trying
  again…**, check that the Hub is running, and on the same subnet as the TV
  (FR-2). It connects by itself as soon as it can, so restarting the Hub never
  needs anyone at the TV.

To remove it:

```bash
tizen uninstall -s 192.168.1.50:26101 -p MediaCntre.Player
```

---

## When it goes wrong

| What you see                                                       | What to do                                                                                                                                                                                   |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sdb connect` fails, or the Device Manager can't connect to the TV | The TV's Developer IP must be the PC's, and the TV restarted since (step 2). The PC and the TV must be on the same network.                                                                  |
| The install fails with a certificate or signature error            | The distributor certificate must list this TV's DUID (step 4), and the profile must be the active one when packaging.                                                                        |
| The install fails because the app is already installed             | The Player on the TV was signed with another author certificate. Uninstall it (step 7), then install again.                                                                                  |
| The Player stays on **Can't reach the Hub. Trying again…**         | Check that the Hub is running and that its address on the screen is the Hub's. A firewall on the Hub's machine must let the TV reach its port.                                               |
| The Developer section has no **Install / update Player**           | The TV must say Developer Mode is on with the Hub's IP as its Developer IP: set it, and restart the TV. A TV that doesn't say, as some firmware doesn't, needs the Player installed by hand. |
| The Hub says the TV didn't let it connect                          | The TV's Developer IP must be the Hub's, the TV restarted since, and no PC connected to it with Tizen Studio meanwhile.                                                                      |
| The Hub says the Player couldn't be signed                         | In Settings, store the certificate again, with each file as its own half and the right password for each.                                                                                    |
| The Hub says the TV didn't install the Player                      | Its message says what the TV said. As above: the certificate must list this TV, and a Player signed with another author certificate must be uninstalled first.                               |
