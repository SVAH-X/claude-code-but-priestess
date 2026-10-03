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
    private const int SW_SHOW = 5;
    private const int SW_MINIMIZE = 6;
    private const int SW_RESTORE = 9;
    // The helper gives itself a deadline so it can still put the client away
    // in its finally block; PRTS only kills it (losing that cleanup) at 40 s.
    private const int HELPER_DEADLINE_MS = 20000;
    private const int WATCHDOG_MS = 30000;
    private const string NOT_FOREGROUND_ERROR = "网易云音乐已不在前台，已停止发送输入";
    private const string TIMEOUT_ERROR = "网易云客户端响应超时";
    private const int SM_SWAPBUTTON = 23;
    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TRANSPARENT = 0x00000020;
    private const int WS_EX_TOOLWINDOW = 0x00000080;
    private const int WS_EX_NOACTIVATE = 0x08000000;
    private const uint GW_OWNER = 4;
    private const uint WM_SYSCOMMAND = 0x0112;
    private const int SC_MINIMIZE = 0xF020;
    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
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

    [StructLayout(LayoutKind.Sequential)]
    private struct WINDOWPLACEMENT
    {
        public uint length;
        public uint flags;
        public uint showCmd;
        public POINT ptMinPosition;
        public POINT ptMaxPosition;
        public RECT rcNormalPosition;
    }

    private static readonly Stopwatch Clock = Stopwatch.StartNew();

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
    private static extern IntPtr WindowFromPoint(POINT point);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    // GetWindowLong (not the Ptr variant) exists in both 32- and 64-bit user32
    // and the extended-style bits fit in 32 bits.
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowLong(IntPtr hWnd, int index);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint command);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(
        IntPtr hWnd,
        StringBuilder text,
        int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(
        IntPtr hWnd,
        StringBuilder className,
        int maxCount);

    [DllImport("user32.dll")]
    private static extern bool GetWindowPlacement(
        IntPtr hWnd,
        ref WINDOWPLACEMENT placement);

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
            StartWatchdog();
            string title = DecodeArgument(args, "--title-b64");
            string query = DecodeArgument(args, "--query-b64");
            if (String.IsNullOrWhiteSpace(title) || String.IsNullOrWhiteSpace(query))
                return Fail("缺少歌曲名称");
            string[] titleCandidates = BuildTitleCandidates(title);

            IntPtr previousForeground = GetForegroundWindow();
            Process process = FindOrLaunchClient();
            if (process == null)
                return Fail("未找到网易云音乐客户端，请先安装桌面版");

            IntPtr handle = WaitForWindow(process, Remaining(12000));
            if (handle == IntPtr.Zero)
                return Fail(DeadlinePassed() ? TIMEOUT_ERROR : "网易云音乐客户端没有可控制的窗口");

            bool minimizeAfterPlayback = !WindowBelongsToProcess(
                previousForeground,
                process.Id);
            string backgroundMode = "kept";
            try
            {
                // SW_RESTORE would un-maximize a maximized window, so only use
                // it to bring back a minimized one; SW_SHOW keeps the current
                // size for a visible or hidden (see PutClientAway) window.
                ShowWindow(handle, IsIconic(handle) ? SW_RESTORE : SW_SHOW);
                SetForegroundWindow(handle);
                if (!WaitForForegroundProcess(process.Id, Remaining(1800)))
                    return Fail(DeadlinePassed()
                        ? TIMEOUT_ERROR
                        : "无法将网易云音乐置于前台，已停止发送搜索输入");
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
                int searchX = windowRect.Left + Math.Min(
                    (int)(400 * scale),
                    Math.Max((int)(180 * scale), width - (int)(180 * scale)));
                int searchY = windowRect.Top + Math.Min(
                    (int)(36 * scale),
                    Math.Max((int)(20 * scale), height - (int)(100 * scale)));

                // Synthetic input goes to whatever is in front, so re-check
                // before every burst that NetEase still is (and, for clicks,
                // that NetEase owns the pixel under the cursor).
                if (!ClientAcceptsInput(process.Id, searchX, searchY))
                    return Fail(NOT_FOREGROUND_ERROR);
                ClickAt(searchX, searchY);
                if (!ClientAcceptsInput(process.Id))
                    return Fail(NOT_FOREGROUND_ERROR);
                KeyDown(VK_CONTROL);
                PressKey(VK_A);
                KeyUp(VK_CONTROL);
                if (!ClientAcceptsInput(process.Id))
                    return Fail(NOT_FOREGROUND_ERROR);
                SendUnicode(query);
                Thread.Sleep(650);
                if (!ClientAcceptsInput(process.Id))
                    return Fail(NOT_FOREGROUND_ERROR);
                PressKey(VK_RETURN);
                Thread.Sleep(1700);
                if (DeadlinePassed())
                    return Fail(TIMEOUT_ERROR);

                // Match the title as a (case- and space-insensitive) substring
                // of the result text: NetEase decorates titles ("夜曲 (Live)")
                // and the request may carry the artist ("周杰伦 晴天").
                List<ElementSnapshot> texts = CollectTextElements(
                    handle,
                    Remaining(3500));
                ElementSnapshot resultTitle = PickResult(texts, titleCandidates);
                if (resultTitle == null && !DeadlinePassed())
                {
                    texts = CollectAccessibleTexts(
                        handle,
                        ROLE_SYSTEM_STATICTEXT,
                        Remaining(3500));
                    resultTitle = PickResult(texts, titleCandidates);
                }
                if (resultTitle == null)
                    return Fail(DeadlinePassed()
                        ? TIMEOUT_ERROR
                        : "网易云搜索结果已打开，但没有找到“" + title + "”");

                int resultX = resultTitle.Left + (resultTitle.Right - resultTitle.Left) / 2;
                int resultY = resultTitle.Top + (resultTitle.Bottom - resultTitle.Top) / 2;
                if (!ClientAcceptsInput(process.Id, resultX, resultY))
                    return Fail(NOT_FOREGROUND_ERROR);
                DoubleClickAt(resultX, resultY);
                if (!WaitForTitle(process, handle, titleCandidates, Remaining(8000)))
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

    private static int Remaining(int cap)
    {
        long left = HELPER_DEADLINE_MS - Clock.ElapsedMilliseconds;
        if (left <= 0) return 0;
        return (int)Math.Min(cap, left);
    }

    private static bool DeadlinePassed()
    {
        return Clock.ElapsedMilliseconds >= HELPER_DEADLINE_MS;
    }

    // Last resort when a UI Automation call never returns: report the timeout
    // ourselves so PRTS gets a readable error instead of a killed process.
    private static void StartWatchdog()
    {
        Thread watchdog = new Thread(() =>
        {
            Thread.Sleep(WATCHDOG_MS);
            Console.WriteLine(FailJson(TIMEOUT_ERROR));
            Console.Out.Flush();
            Environment.Exit(1);
        });
        watchdog.IsBackground = true;
        watchdog.Start();
    }

    private static bool ClientAcceptsInput(int processId)
    {
        return WindowBelongsToProcess(GetForegroundWindow(), processId);
    }

    private static bool ClientAcceptsInput(int processId, int x, int y)
    {
        if (!ClientAcceptsInput(processId)) return false;
        POINT point;
        point.X = x;
        point.Y = y;
        return WindowBelongsToProcess(WindowFromPoint(point), processId);
    }

    private static bool WaitForForegroundProcess(int processId, int timeoutMs)
    {
        Stopwatch watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < timeoutMs)
        {
            if (WindowBelongsToProcess(GetForegroundWindow(), processId))
                return true;
            Thread.Sleep(50);
        }
        return WindowBelongsToProcess(GetForegroundWindow(), processId);
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
            for (int i = 0; i < 30 && !DeadlinePassed(); i++)
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
        // Process.MainWindowHandle is just the first visible top-level window
        // the process owns, which can be the desktop-lyrics or mini-player
        // window. Score every top-level window instead: unowned, not a
        // tool/transparent/no-activate window, no lyrics-like title or class,
        // at least 400x300 in its normal (non-minimized) placement, largest
        // and preferably visible. Hidden windows (PutClientAway's last resort)
        // still qualify so the next request can bring them back.
        int processId = process.Id;
        IntPtr best = IntPtr.Zero;
        long bestScore = 0;
        EnumWindowsProc inspect = delegate(IntPtr candidate, IntPtr ignored)
        {
            long score = ScoreClientWindow(candidate, processId);
            if (score > bestScore)
            {
                best = candidate;
                bestScore = score;
            }
            return true;
        };
        EnumWindows(inspect, IntPtr.Zero);
        if (best != IntPtr.Zero) return best;

        try
        {
            process.Refresh();
            return process.MainWindowHandle;
        }
        catch
        {
            return IntPtr.Zero;
        }
    }

    private static long ScoreClientWindow(IntPtr candidate, int processId)
    {
        if (!WindowBelongsToProcess(candidate, processId)) return 0;
        if (GetWindow(candidate, GW_OWNER) != IntPtr.Zero) return 0;
        int exStyle = GetWindowLong(candidate, GWL_EXSTYLE);
        if ((exStyle & (WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE)) != 0)
            return 0;
        if (LooksLikeLyricsWindow(WindowText(candidate)) ||
            LooksLikeLyricsWindow(WindowClassName(candidate)))
            return 0;

        WINDOWPLACEMENT placement = new WINDOWPLACEMENT();
        placement.length = (uint)Marshal.SizeOf(typeof(WINDOWPLACEMENT));
        int width;
        int height;
        if (GetWindowPlacement(candidate, ref placement))
        {
            width = placement.rcNormalPosition.Right - placement.rcNormalPosition.Left;
            height = placement.rcNormalPosition.Bottom - placement.rcNormalPosition.Top;
        }
        else
        {
            RECT rect;
            if (!GetWindowRect(candidate, out rect)) return 0;
            width = rect.Right - rect.Left;
            height = rect.Bottom - rect.Top;
        }
        if (width < 400 || height < 300) return 0;
        long area = width * (long)height;
        return IsWindowVisible(candidate) ? area * 2 : area;
    }

    private static bool LooksLikeLyricsWindow(string text)
    {
        if (String.IsNullOrEmpty(text)) return false;
        return text.IndexOf("歌词", StringComparison.Ordinal) >= 0 ||
            text.IndexOf("lyric", StringComparison.OrdinalIgnoreCase) >= 0;
    }

    private static string WindowText(IntPtr handle)
    {
        StringBuilder buffer = new StringBuilder(512);
        GetWindowText(handle, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    private static string WindowClassName(IntPtr handle)
    {
        StringBuilder buffer = new StringBuilder(256);
        GetClassName(handle, buffer, buffer.Capacity);
        return buffer.ToString();
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

    // Whitespace-free, lower-case form used for every title comparison.
    private static string NormalizeText(string value)
    {
        if (String.IsNullOrEmpty(value)) return "";
        StringBuilder result = new StringBuilder(value.Length);
        foreach (char character in value)
        {
            if (!Char.IsWhiteSpace(character)) result.Append(character);
        }
        return result.ToString().ToLowerInvariant();
    }

    // The full normalized title first; when the title has several words
    // ("周杰伦 晴天") also each word long enough to identify a song, last
    // word first, so an artist prefix does not prevent finding the song.
    private static string[] BuildTitleCandidates(string title)
    {
        List<string> candidates = new List<string>();
        string full = NormalizeText(title);
        if (full.Length > 0) candidates.Add(full);
        string[] words = title.Split(
            (char[])null,
            StringSplitOptions.RemoveEmptyEntries);
        if (words.Length > 1)
        {
            for (int i = words.Length - 1; i >= 0; i--)
            {
                string word = NormalizeText(words[i]);
                // Two CJK characters identify a song; two Latin letters ("of",
                // "me") would match almost any text, so Latin words need three.
                int minimumLength = IsAscii(word) ? 3 : 2;
                if (word.Length >= minimumLength && !candidates.Contains(word))
                    candidates.Add(word);
            }
        }
        return candidates.ToArray();
    }

    private static bool IsAscii(string value)
    {
        foreach (char character in value)
        {
            if (character > 0x7E) return false;
        }
        return true;
    }

    private static bool TextMatchesAny(string text, string[] candidates)
    {
        string normalized = NormalizeText(text);
        if (normalized.Length == 0) return false;
        foreach (string candidate in candidates)
        {
            if (normalized.IndexOf(candidate, StringComparison.Ordinal) >= 0)
                return true;
        }
        return false;
    }

    // Exact match of the full title wins. Otherwise, per candidate in order
    // (full title, then single words), the shortest text containing it: a
    // result row's title cell is compact ("夜曲 (Live)"), whereas the results
    // header ("搜索“周杰伦 晴天”…找到 N 首单曲") also contains the title but
    // is long, and double-clicking it would play nothing.
    private static ElementSnapshot PickResult(
        List<ElementSnapshot> texts,
        string[] candidates)
    {
        if (texts == null || candidates.Length == 0) return null;
        foreach (ElementSnapshot text in texts)
        {
            if (NormalizeText(text.Name) == candidates[0]) return text;
        }
        foreach (string candidate in candidates)
        {
            ElementSnapshot best = null;
            int bestLength = Int32.MaxValue;
            foreach (ElementSnapshot text in texts)
            {
                string normalized = NormalizeText(text.Name);
                if (normalized.IndexOf(candidate, StringComparison.Ordinal) < 0)
                    continue;
                if (normalized.Length < bestLength)
                {
                    best = text;
                    bestLength = normalized.Length;
                }
            }
            if (best != null) return best;
        }
        return null;
    }

    private static List<ElementSnapshot> CollectTextElements(
        IntPtr handle,
        int timeoutMs)
    {
        List<ElementSnapshot> result = new List<ElementSnapshot>();
        if (timeoutMs <= 0) return result;
        Thread worker = new Thread(() =>
        {
            try
            {
                Condition condition = new PropertyCondition(
                    AutomationElement.ControlTypeProperty,
                    ControlType.Text);
                foreach (IntPtr candidateHandle in GetWindowHandles(handle))
                {
                    AutomationElement root = AutomationElement.FromHandle(candidateHandle);
                    AutomationElementCollection elements = root.FindAll(
                        TreeScope.Descendants,
                        condition);
                    foreach (AutomationElement element in elements)
                    {
                        Rect rect = element.Current.BoundingRectangle;
                        if (rect.IsEmpty) continue;
                        string name = element.Current.Name ?? "";
                        if (name.Length == 0) continue;
                        ElementSnapshot snapshot = new ElementSnapshot
                        {
                            Left = (int)rect.Left,
                            Top = (int)rect.Top,
                            Right = (int)rect.Right,
                            Bottom = (int)rect.Bottom,
                            Name = name
                        };
                        lock (result) result.Add(snapshot);
                    }
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
        worker.Join(timeoutMs);
        // Whatever was collected before the deadline is still usable.
        lock (result) return new List<ElementSnapshot>(result);
    }

    private static List<ElementSnapshot> CollectAccessibleTexts(
        IntPtr handle,
        int role,
        int timeoutMs)
    {
        List<ElementSnapshot> result = new List<ElementSnapshot>();
        if (timeoutMs <= 0) return result;
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
                    CollectAccessibleTextsCore(
                        root,
                        role,
                        0,
                        ref visited,
                        result);
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
        worker.Join(timeoutMs);
        lock (result) return new List<ElementSnapshot>(result);
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

    private static void CollectAccessibleTextsCore(
        IAccessible accessible,
        int role,
        int depth,
        ref int visited,
        List<ElementSnapshot> result)
    {
        if (accessible == null || depth > 40 || visited >= 6000) return;
        visited++;

        ElementSnapshot self = SnapshotAccessibleChild(
            accessible,
            CHILDID_SELF,
            role);
        if (self != null) lock (result) result.Add(self);

        int childCount;
        try
        {
            childCount = accessible.accChildCount;
        }
        catch
        {
            return;
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
                CollectAccessibleTextsCore(
                    childAccessible,
                    role,
                    depth + 1,
                    ref visited,
                    result);
                continue;
            }

            visited++;
            ElementSnapshot simple = SnapshotAccessibleChild(
                accessible,
                childId,
                role);
            if (simple != null) lock (result) result.Add(simple);
        }
    }

    private static ElementSnapshot SnapshotAccessibleChild(
        IAccessible accessible,
        object childId,
        int expectedRole)
    {
        try
        {
            object roleValue = accessible.get_accRole(childId);
            if (roleValue == null || Convert.ToInt32(roleValue) != expectedRole)
                return null;
            string name = accessible.get_accName(childId) ?? "";
            if (name.Length == 0) return null;

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

    private static bool WaitForTitle(
        Process process,
        IntPtr handle,
        string[] candidates,
        int timeoutMs)
    {
        Stopwatch watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < timeoutMs)
        {
            if (WindowTitleMatches(process, handle, candidates)) return true;
            Thread.Sleep(250);
        }
        return WindowTitleMatches(process, handle, candidates);
    }

    // The window we drive is checked first; Process.MainWindowTitle is kept
    // as a fallback in case the client reports the playing song elsewhere.
    private static bool WindowTitleMatches(
        Process process,
        IntPtr handle,
        string[] candidates)
    {
        if (TextMatchesAny(WindowText(handle), candidates)) return true;
        try
        {
            process.Refresh();
            return TextMatchesAny(process.MainWindowTitle, candidates);
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
        // The LEFT/RIGHT flags name physical buttons. With "swap mouse
        // buttons" on, the primary (logical left) click is the physical right.
        bool swapped = GetSystemMetrics(SM_SWAPBUTTON) != 0;
        INPUT down = new INPUT();
        down.type = INPUT_MOUSE;
        down.U.mi.dwFlags = swapped ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
        INPUT up = new INPUT();
        up.type = INPUT_MOUSE;
        up.U.mi.dwFlags = swapped ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
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
        Console.WriteLine(FailJson(error));
        return 1;
    }

    private static string FailJson(string error)
    {
        return "{\"ok\":false,\"error\":\"" + EscapeJson(error) + "\"}";
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
                    // Console.Out encodes in the OEM code page while PRTS decodes
                    // UTF-8, so keep the JSON pure ASCII: escape every non-ASCII
                    // character (Chinese error text included) as \uXXXX.
                    if (character < 0x20 || character > 0x7E)
                        result.Append("\\u" + ((int)character).ToString("x4"));
                    else
                        result.Append(character);
                    break;
            }
        }
        return result.ToString();
    }
}
