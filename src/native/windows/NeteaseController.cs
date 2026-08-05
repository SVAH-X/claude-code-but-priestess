using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Automation;
using Accessibility;

internal static class NeteaseController
{
    private const int SW_HIDE = 0;
    private const int SW_MINIMIZE = 6;
    private const int SW_RESTORE = 9;
    private const uint WM_SYSCOMMAND = 0x0112;
    private const int SC_MINIMIZE = 0xF020;
    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const ushort VK_CONTROL = 0x11;
    private const ushort VK_A = 0x41;
    private const ushort VK_RETURN = 0x0D;
    private const uint OBJID_CLIENT = 0xFFFFFFFC;
    private const int CHILDID_SELF = 0;
    private const int ROLE_SYSTEM_STATICTEXT = 0x29;

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    private sealed class ElementSnapshot
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
        public string Name;
    }

    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(
        IntPtr hWnd,
        uint message,
        IntPtr wParam,
        IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(
        IntPtr hWnd,
        out uint processId);

    [DllImport("user32.dll")]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT point);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(
        EnumWindowsProc callback,
        IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(
        IntPtr hwndParent,
        EnumWindowsProc callback,
        IntPtr lParam);

    [DllImport("oleacc.dll")]
    private static extern int AccessibleObjectFromWindow(
        IntPtr hwnd,
        uint dwObjectID,
        ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IAccessible accessible);

    private static int Main(string[] args)
    {
        try
        {
            SetProcessDPIAware();
            string title = DecodeArgument(args, "--title-b64");
            string query = DecodeArgument(args, "--query-b64");
            if (String.IsNullOrWhiteSpace(title) || String.IsNullOrWhiteSpace(query))
                return Fail("缺少歌曲名称");

            IntPtr previousForeground = GetForegroundWindow();
            Process process = FindOrLaunchClient();
            if (process == null)
                return Fail("未找到网易云音乐客户端，请先安装桌面版");

            IntPtr handle = WaitForWindow(process, 12000);
            if (handle == IntPtr.Zero)
                return Fail("网易云音乐客户端没有可控制的窗口");

            bool minimizeAfterPlayback = !WindowBelongsToProcess(
                previousForeground,
                process.Id);
            string backgroundMode = "kept";
            try
            {
                ShowWindow(handle, SW_RESTORE);
                SetForegroundWindow(handle);
                Thread.Sleep(350);

                RECT windowRect;
                if (!GetWindowRect(handle, out windowRect))
                    return Fail("无法读取网易云音乐窗口的位置");

                // The title-bar search box is stable across NetEase 3.x layouts.
                // Search-result cards are not: an optional artist block moves them
                // by more than 100 px. Find the exact song-title text through the
                // accessibility tree and double-click that element instead.
                int width = windowRect.Right - windowRect.Left;
                int height = windowRect.Bottom - windowRect.Top;
                uint dpi = GetDpiForWindow(handle);
                double scale = dpi > 0 ? dpi / 96.0 : 1.0;
                ClickAt(
                    windowRect.Left + Math.Min(
                        (int)(400 * scale),
                        Math.Max((int)(180 * scale), width - (int)(180 * scale))),
                    windowRect.Top + Math.Min(
                        (int)(36 * scale),
                        Math.Max((int)(20 * scale), height - (int)(100 * scale))));
                KeyDown(VK_CONTROL);
                PressKey(VK_A);
                KeyUp(VK_CONTROL);
                SendUnicode(query);
                Thread.Sleep(650);
                PressKey(VK_RETURN);
                Thread.Sleep(1700);

                ElementSnapshot resultTitle = FindElement(
                    handle,
                    new AndCondition(
                        new PropertyCondition(
                            AutomationElement.ControlTypeProperty,
                            ControlType.Text),
                        new PropertyCondition(
                            AutomationElement.NameProperty,
                            title,
                            PropertyConditionFlags.IgnoreCase)),
                    3500);
                if (resultTitle == null)
                {
                    resultTitle = FindAccessibleElement(
                        handle,
                        ROLE_SYSTEM_STATICTEXT,
                        new[] { title },
                        3500);
                }
                if (resultTitle == null)
                    return Fail("网易云搜索结果已打开，但没有找到“" + title + "”");

                DoubleClickAt(
                    resultTitle.Left + (resultTitle.Right - resultTitle.Left) / 2,
                    resultTitle.Top + (resultTitle.Bottom - resultTitle.Top) / 2);
                if (!WaitForTitle(process, title, 8000))
                    return Fail("网易云搜索到了歌曲，但没有切换到“" + title + "”");
            }
            finally
            {
                if (minimizeAfterPlayback)
                    backgroundMode = PutClientAway(handle, previousForeground);
            }
            return Success("search", title, backgroundMode);
        }
        catch (Exception error)
        {
            return Fail(error.Message);
        }
    }

    private static bool WindowBelongsToProcess(IntPtr handle, int processId)
    {
        if (handle == IntPtr.Zero) return false;
        uint ownerProcessId;
        GetWindowThreadProcessId(handle, out ownerProcessId);
        return ownerProcessId == (uint)processId;
    }

    private static string PutClientAway(
        IntPtr clientHandle,
        IntPtr previousForeground)
    {
        // First use the same system command as the title-bar minimize button.
        // NetEase's Chromium shell can ignore or undo a lone ShowWindow call
        // while its search page is still settling, so verify the final state.
        Thread.Sleep(450);
        PostMessage(
            clientHandle,
            WM_SYSCOMMAND,
            new IntPtr(SC_MINIMIZE),
            IntPtr.Zero);
        if (!WaitForMinimized(clientHandle, 1200))
        {
            ShowWindowAsync(clientHandle, SW_MINIMIZE);
            WaitForMinimized(clientHandle, 800);
        }

        if (
            previousForeground != IntPtr.Zero &&
            previousForeground != clientHandle &&
            IsWindow(previousForeground))
        {
            SetForegroundWindow(previousForeground);
        }

        // A late Chromium activation can restore the window after the first
        // minimize. Check once more; if it still refuses, hide it as a reliable
        // last resort. Hidden windows remain discoverable by FindClientWindow,
        // so the next PRTS request can restore them without restarting NetEase.
        Thread.Sleep(450);
        if (!IsIconic(clientHandle))
        {
            ShowWindowAsync(clientHandle, SW_MINIMIZE);
            if (!WaitForMinimized(clientHandle, 600))
                ShowWindow(clientHandle, SW_HIDE);
        }

        if (IsIconic(clientHandle)) return "minimized";
        if (!IsWindowVisible(clientHandle)) return "hidden";
        return "failed";
    }

    private static bool WaitForMinimized(IntPtr handle, int timeoutMs)
    {
        Stopwatch watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < timeoutMs)
        {
            if (IsIconic(handle)) return true;
            Thread.Sleep(80);
        }
        return IsIconic(handle);
    }

    private static string DecodeArgument(string[] args, string key)
    {
        for (int i = 0; i + 1 < args.Length; i++)
        {
            if (String.Equals(args[i], key, StringComparison.Ordinal))
                return Encoding.UTF8.GetString(Convert.FromBase64String(args[i + 1]));
        }
        return "";
    }

    private static Process FindOrLaunchClient()
    {
        Process process = FindClient();
        if (process != null) return process;

        string[] candidates = {
            Environment.ExpandEnvironmentVariables(@"%ProgramFiles%\NetEase\CloudMusic\cloudmusic.exe"),
            Environment.ExpandEnvironmentVariables(@"%ProgramFiles(x86)%\NetEase\CloudMusic\cloudmusic.exe"),
            Environment.ExpandEnvironmentVariables(@"%LOCALAPPDATA%\NetEase\CloudMusic\cloudmusic.exe")
        };
        foreach (string candidate in candidates)
        {
            if (!System.IO.File.Exists(candidate)) continue;
            Process.Start(candidate);
            for (int i = 0; i < 30; i++)
            {
                Thread.Sleep(300);
                process = FindClient();
                if (process != null) return process;
            }
        }
        return null;
    }

    private static Process FindClient()
    {
        Process[] processes = Process.GetProcessesByName("cloudmusic");
        Process best = null;
        long bestArea = 0;
        foreach (Process process in processes)
        {
            IntPtr handle = FindClientWindow(process);
            if (handle == IntPtr.Zero) continue;
            RECT rect;
            long area = GetWindowRect(handle, out rect)
                ? Math.Max(0, rect.Right - rect.Left) *
                  (long)Math.Max(0, rect.Bottom - rect.Top)
                : 0;
            if (best == null || area > bestArea)
            {
                best = process;
                bestArea = area;
            }
        }
        return best;
    }

    private static IntPtr FindClientWindow(Process process)
    {
        try
        {
            process.Refresh();
            if (process.MainWindowHandle != IntPtr.Zero)
                return process.MainWindowHandle;
        }
        catch
        {
            return IntPtr.Zero;
        }

        // A window hidden by the tray (or by an interrupted older helper run)
        // is omitted from Process.MainWindowHandle. Find the large top-level
        // window owned by the main cloudmusic process so it remains recoverable.
        IntPtr best = IntPtr.Zero;
        long bestArea = 0;
        EnumWindowsProc inspect = delegate(IntPtr candidate, IntPtr ignored)
        {
            uint ownerProcessId;
            GetWindowThreadProcessId(candidate, out ownerProcessId);
            if (ownerProcessId != (uint)process.Id) return true;

            RECT rect;
            if (!GetWindowRect(candidate, out rect)) return true;
            int width = Math.Max(0, rect.Right - rect.Left);
            int height = Math.Max(0, rect.Bottom - rect.Top);
            if (width < 400 || height < 300) return true;
            long area = width * (long)height;
            if (area > bestArea)
            {
                best = candidate;
                bestArea = area;
            }
            return true;
        };
        EnumWindows(inspect, IntPtr.Zero);
        return best;
    }

    private static IntPtr WaitForWindow(Process process, int timeoutMs)
    {
        Stopwatch watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < timeoutMs)
        {
            IntPtr handle = FindClientWindow(process);
            if (handle != IntPtr.Zero) return handle;
            Thread.Sleep(200);
        }
        return IntPtr.Zero;
    }

    private static void ClickAt(int x, int y)
    {
        POINT original;
        GetCursorPos(out original);
        SetCursorPos(x, y);
        Thread.Sleep(80);
        MouseClick();
        Thread.Sleep(80);
        SetCursorPos(original.X, original.Y);
    }

    private static void DoubleClickAt(int x, int y)
    {
        POINT original;
        GetCursorPos(out original);
        SetCursorPos(x, y);
        Thread.Sleep(80);
        MouseClick();
        Thread.Sleep(120);
        MouseClick();
        Thread.Sleep(80);
        SetCursorPos(original.X, original.Y);
    }

    private static ElementSnapshot FindElement(
        IntPtr handle,
        Condition condition,
        int timeoutMs)
    {
        ElementSnapshot result = null;
        Thread worker = new Thread(() =>
        {
            try
            {
                foreach (IntPtr candidateHandle in GetWindowHandles(handle))
                {
                    AutomationElement root = AutomationElement.FromHandle(candidateHandle);
                    AutomationElement element = root.FindFirst(
                        TreeScope.Descendants,
                        condition);
                    if (element == null) continue;
                    Rect rect = element.Current.BoundingRectangle;
                    if (rect.IsEmpty) continue;
                    result = new ElementSnapshot
                    {
                        Left = (int)rect.Left,
                        Top = (int)rect.Top,
                        Right = (int)rect.Right,
                        Bottom = (int)rect.Bottom,
                        Name = element.Current.Name ?? ""
                    };
                    return;
                }
            }
            catch
            {
                // A Chromium accessibility tree can disappear mid-query.
            }
        });
        worker.IsBackground = true;
        worker.SetApartmentState(ApartmentState.MTA);
        worker.Start();
        return worker.Join(timeoutMs) ? result : null;
    }

    private static ElementSnapshot FindAccessibleElement(
        IntPtr handle,
        int role,
        string[] names,
        int timeoutMs)
    {
        ElementSnapshot result = null;
        Thread worker = new Thread(() =>
        {
            try
            {
                Guid iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
                int visited = 0;
                foreach (IntPtr candidateHandle in GetWindowHandles(handle))
                {
                    IAccessible root;
                    if (AccessibleObjectFromWindow(
                        candidateHandle,
                        OBJID_CLIENT,
                        ref iid,
                        out root) != 0 || root == null) continue;
                    result = FindAccessibleElementCore(
                        root,
                        role,
                        names,
                        0,
                        ref visited);
                    if (result != null) return;
                }
            }
            catch
            {
                // Chromium can replace its accessibility tree mid-search.
            }
        });
        worker.IsBackground = true;
        worker.SetApartmentState(ApartmentState.MTA);
        worker.Start();
        return worker.Join(timeoutMs) ? result : null;
    }

    private static List<IntPtr> GetWindowHandles(IntPtr root)
    {
        List<IntPtr> handles = new List<IntPtr>();
        handles.Add(root);
        EnumWindowsProc collect = delegate(IntPtr child, IntPtr ignored)
        {
            handles.Add(child);
            return true;
        };
        EnumChildWindows(root, collect, IntPtr.Zero);
        return handles;
    }

    private static ElementSnapshot FindAccessibleElementCore(
        IAccessible accessible,
        int role,
        string[] names,
        int depth,
        ref int visited)
    {
        if (accessible == null || depth > 40 || visited >= 6000) return null;
        visited++;

        ElementSnapshot self = SnapshotAccessibleChild(
            accessible,
            CHILDID_SELF,
            role,
            names);
        if (self != null) return self;

        int childCount;
        try
        {
            childCount = accessible.accChildCount;
        }
        catch
        {
            return null;
        }
        for (int childId = 1; childId <= childCount && visited < 6000; childId++)
        {
            object child = null;
            try
            {
                child = accessible.get_accChild(childId);
            }
            catch
            {
                // Simple MSAA children are addressed through their parent.
            }

            IAccessible childAccessible = child as IAccessible;
            if (childAccessible != null)
            {
                ElementSnapshot nested = FindAccessibleElementCore(
                    childAccessible,
                    role,
                    names,
                    depth + 1,
                    ref visited);
                if (nested != null) return nested;
                continue;
            }

            visited++;
            ElementSnapshot simple = SnapshotAccessibleChild(
                accessible,
                childId,
                role,
                names);
            if (simple != null) return simple;
        }
        return null;
    }

    private static ElementSnapshot SnapshotAccessibleChild(
        IAccessible accessible,
        object childId,
        int expectedRole,
        string[] names)
    {
        try
        {
            object roleValue = accessible.get_accRole(childId);
            if (roleValue == null || Convert.ToInt32(roleValue) != expectedRole)
                return null;
            string name = accessible.get_accName(childId) ?? "";
            if (!NameMatches(name, names)) return null;

            int left;
            int top;
            int width;
            int height;
            accessible.accLocation(
                out left,
                out top,
                out width,
                out height,
                childId);
            if (width <= 0 || height <= 0) return null;
            return new ElementSnapshot
            {
                Left = left,
                Top = top,
                Right = left + width,
                Bottom = top + height,
                Name = name
            };
        }
        catch
        {
            return null;
        }
    }

    private static bool NameMatches(string actual, string[] expected)
    {
        foreach (string name in expected)
        {
            if (String.Equals(
                actual,
                name,
                StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static bool WaitForTitle(Process process, string title, int timeoutMs)
    {
        Stopwatch watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < timeoutMs)
        {
            if (WindowTitleMatches(process, title)) return true;
            Thread.Sleep(250);
        }
        return false;
    }

    private static bool WindowTitleMatches(Process process, string title)
    {
        try
        {
            process.Refresh();
            return process.MainWindowTitle.IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0;
        }
        catch
        {
            return false;
        }
    }

    private static void KeyDown(ushort key)
    {
        SendKeyboard(key, 0, 0);
    }

    private static void KeyUp(ushort key)
    {
        SendKeyboard(key, 0, KEYEVENTF_KEYUP);
    }

    private static void PressKey(ushort key)
    {
        KeyDown(key);
        KeyUp(key);
    }

    private static void SendUnicode(string text)
    {
        foreach (char character in text)
        {
            SendKeyboard(0, character, KEYEVENTF_UNICODE);
            SendKeyboard(0, character, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
        }
    }

    private static void SendKeyboard(ushort key, ushort scan, uint flags)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.U.ki.wVk = key;
        input.U.ki.wScan = scan;
        input.U.ki.dwFlags = flags;
        SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
    }

    private static void MouseClick()
    {
        INPUT down = new INPUT();
        down.type = INPUT_MOUSE;
        down.U.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
        INPUT up = new INPUT();
        up.type = INPUT_MOUSE;
        up.U.mi.dwFlags = MOUSEEVENTF_LEFTUP;
        SendInput(2, new[] { down, up }, Marshal.SizeOf(typeof(INPUT)));
    }

    private static int Success(
        string method,
        string title,
        string backgroundMode)
    {
        Console.WriteLine(
            "{\"ok\":true,\"method\":\"" + EscapeJson(method) +
            "\",\"title\":\"" + EscapeJson(title) +
            "\",\"backgroundMode\":\"" +
            EscapeJson(backgroundMode) + "\"}");
        return 0;
    }

    private static int Fail(string error)
    {
        Console.WriteLine("{\"ok\":false,\"error\":\"" + EscapeJson(error) + "\"}");
        return 1;
    }

    private static string EscapeJson(string value)
    {
        if (value == null) return "";
        StringBuilder result = new StringBuilder();
        foreach (char character in value)
        {
            switch (character)
            {
                case '\\': result.Append("\\\\"); break;
                case '"': result.Append("\\\""); break;
                case '\r': result.Append("\\r"); break;
                case '\n': result.Append("\\n"); break;
                case '\t': result.Append("\\t"); break;
                default:
                    if (character < 0x20)
                        result.Append("\\u" + ((int)character).ToString("x4"));
                    else
                        result.Append(character);
                    break;
            }
        }
        return result.ToString();
    }
}
