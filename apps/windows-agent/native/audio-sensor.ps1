$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class Authenti8Audio {
  public sealed class Endpoint { public string id; public string name; public string provider;
    public string direction; public string state; public bool isDefault; }
  enum Flow { Render, Capture, All }
  enum Role { Console, Multimedia, Communications }
  [Flags] enum DeviceState : uint { Active=1, Disabled=2, NotPresent=4, Unplugged=8, All=15 }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class EnumeratorComObject { }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
  interface IDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(Flow flow, DeviceState mask, out IDeviceCollection devices);
    [PreserveSig] int GetDefaultAudioEndpoint(Flow flow, Role role, out IDevice device);
  }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0BD7A1BE-7A1A-44DB-8397-C0A4BBF2D366")]
  interface IDeviceCollection {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int Item(uint index, out IDevice device);
  }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("D666063F-1587-4E43-81F1-B948E807363F")]
  interface IDevice {
    [PreserveSig] int Activate(ref Guid id, uint context, IntPtr activation,
      [MarshalAs(UnmanagedType.IUnknown)] out object value);
    [PreserveSig] int OpenPropertyStore(uint access, out IPropertyStore properties);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out DeviceState state);
  }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
  interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropertyValue value);
    [PreserveSig] int SetValue(ref PropertyKey key, ref PropertyValue value);
    [PreserveSig] int Commit();
  }
  [StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid format; public uint id; }
  [StructLayout(LayoutKind.Explicit)] struct PropertyValue { [FieldOffset(0)] public ushort type;
    [FieldOffset(8)] public IntPtr pointer; public string Text { get { return type == 31 ? Marshal.PtrToStringUni(pointer) : null; } } }

  public static Endpoint[] Capture() {
    var enumerator = (IDeviceEnumerator)new EnumeratorComObject(); var result = new List<Endpoint>();
    AddFlow(enumerator, result, Flow.Capture, "CAPTURE"); AddFlow(enumerator, result, Flow.Render, "RENDER");
    return result.ToArray();
  }
  static void AddFlow(IDeviceEnumerator enumerator, List<Endpoint> result, Flow flow, string direction) {
    IDeviceCollection devices; if (enumerator.EnumAudioEndpoints(flow, DeviceState.All, out devices) != 0) return;
    string defaultId = null; IDevice defaultDevice;
    if (enumerator.GetDefaultAudioEndpoint(flow, Role.Communications, out defaultDevice) == 0) defaultDevice.GetId(out defaultId);
    uint count; devices.GetCount(out count);
    for (uint index = 0; index < count; index++) { IDevice device; devices.Item(index, out device);
      string id; DeviceState state; device.GetId(out id); device.GetState(out state);
      result.Add(new Endpoint { id=id, name=Property(device, 14, "Unknown audio endpoint"),
        provider=Property(device, 13, null), direction=direction,
        state=StateName(state), isDefault=id == defaultId }); }
  }
  static string Property(IDevice device, uint id, string fallback) { IPropertyStore store;
    device.OpenPropertyStore(0, out store); var key = new PropertyKey {
      format = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), id = id };
    PropertyValue value; store.GetValue(ref key, out value); return value.Text ?? fallback; }
  static string StateName(DeviceState state) { if ((state & DeviceState.Active) != 0) return "ACTIVE";
    if ((state & DeviceState.Disabled) != 0) return "DISABLED";
    if ((state & DeviceState.Unplugged) != 0) return "UNPLUGGED"; return "NOT_PRESENT"; }
}
'@
[Authenti8Audio]::Capture() | ConvertTo-Json -Compress -Depth 3
