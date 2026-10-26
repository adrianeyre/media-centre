// Listens for Bluetooth LE advertisements with Windows' own API, for the
// Hub's Bluetooth scan, and writes each it hears as a line on its standard
// output, until it has listened for as many seconds as its one argument says:
//
//   ADVERT <address> <type> <dBm> <name> <company ids> <service UUIDs>
//   STOPPED <why>
//   DONE
//
// separated by tabs, the address as 12 hex digits, its type 0 for a maker's,
// 1 for a made-up one and 2 for one Windows doesn't say, the name as the hex
// of its UTF-8, and the company ids, as 4 hex digits, and the UUIDs each
// separated by commas. The Hub compiles it with the C# compiler every Windows
// has, from .NET Framework 4, so it is C# 5.
using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using Windows.Devices.Bluetooth.Advertisement;

public static class BleWatch {
  public static int Main(string[] args) {
    int seconds = args.Length > 0 ? int.Parse(args[0]) : 20;
    object gate = new object();
    var watcher = new BluetoothLEAdvertisementWatcher();
    watcher.ScanningMode = BluetoothLEScanningMode.Active;
    watcher.Received += (sender, heard) => {
      var companies = new List<string>();
      foreach (var data in heard.Advertisement.ManufacturerData) companies.Add(data.CompanyId.ToString("x4"));
      var uuids = new List<string>();
      foreach (var uuid in heard.Advertisement.ServiceUuids) uuids.Add(uuid.ToString());
      var name = BitConverter.ToString(Encoding.UTF8.GetBytes(heard.Advertisement.LocalName ?? "")).Replace("-", "");
      var line = string.Join("\t", new[] {
        "ADVERT",
        heard.BluetoothAddress.ToString("x12"),
        ((int)heard.BluetoothAddressType).ToString(),
        heard.RawSignalStrengthInDBm.ToString(),
        name,
        string.Join(",", companies),
        string.Join(",", uuids),
      });
      lock (gate) { Console.WriteLine(line); Console.Out.Flush(); }
    };
    watcher.Stopped += (sender, stopped) => {
      if (stopped.Error != Windows.Devices.Bluetooth.BluetoothError.Success) {
        lock (gate) { Console.WriteLine("STOPPED\t" + stopped.Error); Console.Out.Flush(); }
      }
    };
    watcher.Start();
    Thread.Sleep(seconds * 1000);
    watcher.Stop();
    lock (gate) { Console.WriteLine("DONE"); Console.Out.Flush(); }
    return 0;
  }
}
