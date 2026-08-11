$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class Authenti8Windows {
  public sealed class WindowInfo {
    public string handle;
    public int ownerProcessId;
    public bool visible;
    public bool topmost;
    public bool layered;
    public bool transparent;
    public bool captureExcluded;
    public string title;
    public string className;
    public Bounds bounds;
  }
  public sealed class Bounds { public int left; public int top; public int width; public int height; }
  private delegate bool EnumProc(IntPtr handle, IntPtr parameter);
  [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr handle, out Rect rect);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr(IntPtr handle, int index);
  [DllImport("user32.dll")] private static extern bool GetWindowDisplayAffinity(IntPtr handle, out uint affinity);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, StringBuilder text, int maximum);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr handle, StringBuilder text, int maximum);

  public static WindowInfo[] Capture() {
    var result = new List<WindowInfo>();
    EnumWindows((handle, parameter) => { Add(result, handle); return true; }, IntPtr.Zero);
    return result.ToArray();
  }
  private static void Add(List<WindowInfo> result, IntPtr handle) {
    uint processId; Rect rect; uint affinity = 0;
    GetWindowThreadProcessId(handle, out processId);
    if (processId == 0 || !GetWindowRect(handle, out rect)) return;
    long styles = GetWindowLongPtr(handle, -20).ToInt64();
    GetWindowDisplayAffinity(handle, out affinity);
    var title = new StringBuilder(512); var className = new StringBuilder(256);
    GetWindowText(handle, title, title.Capacity); GetClassName(handle, className, className.Capacity);
    result.Add(new WindowInfo { handle = handle.ToInt64().ToString("x"), ownerProcessId = (int)processId,
      visible = IsWindowVisible(handle), topmost = (styles & 0x8) != 0,
      transparent = (styles & 0x20) != 0, layered = (styles & 0x80000) != 0,
      captureExcluded = affinity == 1 || affinity == 0x11, title = title.ToString(),
      className = className.ToString(), bounds = new Bounds { left = rect.Left, top = rect.Top,
        width = Math.Max(0, rect.Right - rect.Left), height = Math.Max(0, rect.Bottom - rect.Top) } });
  }
}
'@
[Authenti8Windows]::Capture() | ConvertTo-Json -Compress -Depth 4
