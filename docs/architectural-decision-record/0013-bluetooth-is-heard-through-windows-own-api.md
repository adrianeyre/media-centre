# Bluetooth is heard through Windows' own API, by a helper the Hub compiles

The Network tab lists the Bluetooth Low Energy devices near the Hub's PC, to find the household's Bluetooth bulbs. The Hub runs on the owner's Windows PC, so it listens with Windows' own Bluetooth LE API (`BluetoothLEAdvertisementWatcher`). Node can't call that API itself, and Windows PowerShell can't subscribe to its events. So the Hub compiles a small C# helper, `ble-watch.cs`, with the C# compiler every Windows has, from .NET Framework 4, into the system's temporary folder, the first time it listens. It then runs the helper for each scan, and reads each advertisement it writes as a line.

The makers' and services' names are the Bluetooth SIG's assigned numbers, generated into the Hub by a script, so they work offline.

## Considered Options

- **`@abandonware/noble`** and its forks: the usual Node Bluetooth library, but a native module, and on Windows it needs the PC's Bluetooth driver replaced with WinUSB (by Zadig), which stops Windows itself using the adapter. Rejected.
- **A native Node addon against WinRT**: no driver swap, but a native module to build for each Node version. Rejected for the build it adds.
- **Windows PowerShell with WinRT types**: nothing to compile, but it can't subscribe to WinRT events. Tried, and rejected.
- **A prebuilt helper `.exe` in the repository**: no compiling, but a binary in the repository, which can't be reviewed. Rejected for the source compiled on the machine.

## Consequences

- Only a Hub running on Windows, on a PC with Bluetooth switched on, can listen. Elsewhere, the view says so and its button is disabled. A Hub in Docker or on a NAS can't.
- The Hub needs nothing installed for it: `csc.exe` and Windows' API metadata come with Windows. The helper is compiled once for each version of its source, and again if deleted.
- Antivirus may look at the helper as it is compiled and first run.
- Only devices that advertise are heard. A bulb connected to a phone usually stops advertising, so the view says to close its app and switch off the phone's Bluetooth.
- The Hub only listens. It doesn't pair with or connect to anything, so it can't yet control a Bluetooth bulb; that needs the bulb's protocol, and a Driver.
- Tests run a fake helper, `fake-ble-watch.ts`, in its place (`BLUETOOTH_HELPER`), on any machine. No test uses the real radio.
