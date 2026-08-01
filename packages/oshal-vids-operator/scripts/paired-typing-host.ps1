$ErrorActionPreference = 'Stop'

# Persistent Windows input host. Node sends commands over stdin and receives
# status events on stdout. No prepared text is ever echoed or logged.
$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class PairedTypingHost
{
    const int WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14;
    const int WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105;
    const int WM_MOUSEMOVE = 0x200, WM_LBUTTONDOWN = 0x201, WM_RBUTTONDOWN = 0x204, WM_MBUTTONDOWN = 0x207;
    const int WM_QUIT = 0x12, VK_ESCAPE = 0x1B, VK_F8 = 0x77, VK_F9 = 0x78;
    const uint LLKHF_INJECTED = 0x10, LLMHF_INJECTED = 0x01;
    const uint INPUT_KEYBOARD = 1, KEYEVENTF_KEYUP = 0x02, KEYEVENTF_UNICODE = 0x04;

    static readonly object Gate = new object(), OutputGate = new object();
    static readonly Queue<string> Pending = new Queue<string>();
    static readonly HashSet<int> SuppressedKeys = new HashSet<int>();
    static LowLevelKeyboardProc keyboardProc;
    static LowLevelMouseProc mouseProc;
    static IntPtr keyboardHook, mouseHook, targetWindow;
    static bool armed, paused, haveMousePoint;
    static int completed, total;
    static uint messageThreadId;
    static POINT lastMousePoint;

    public static void Run()
    {
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = new UTF8Encoding(false);
        messageThreadId = GetCurrentThreadId();
        keyboardProc = KeyboardCallback;
        mouseProc = MouseCallback;

        using (Process process = Process.GetCurrentProcess())
        using (ProcessModule module = process.MainModule)
        {
            IntPtr moduleHandle = GetModuleHandle(module.ModuleName);
            keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, keyboardProc, moduleHandle, 0);
            mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, moduleHandle, 0);
        }
        if (keyboardHook == IntPtr.Zero || mouseHook == IntPtr.Zero)
        {
            Emit("ERROR could_not_install_windows_hooks");
            Cleanup();
            return;
        }

        Thread reader = new Thread(ReadCommands);
        reader.IsBackground = true;
        reader.Name = "paired-typing-command-reader";
        reader.Start();
        Emit("READY");

        MSG message;
        while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref message);
            DispatchMessage(ref message);
        }
        Cleanup();
    }

    static void ReadCommands()
    {
        try
        {
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                int separator = line.IndexOf(' ');
                string command = (separator < 0 ? line : line.Substring(0, separator)).Trim().ToUpperInvariant();
                string value = separator < 0 ? "" : line.Substring(separator + 1).Trim();
                if (command == "TYPE")
                    Arm(Encoding.UTF8.GetString(Convert.FromBase64String(value)));
                else if (command == "PAUSE")
                    Pause("operator");
                else if (command == "RESUME")
                    Resume();
                else if (command == "CANCEL")
                    Cancel("operator");
                else if (command == "QUIT")
                {
                    PostThreadMessage(messageThreadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
                    return;
                }
            }
            PostThreadMessage(messageThreadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        }
        catch (Exception error)
        {
            Emit("ERROR " + Safe(error.Message));
            PostThreadMessage(messageThreadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        }
    }

    static void Arm(string text)
    {
        List<string> elements = new List<string>();
        TextElementEnumerator enumerator = StringInfo.GetTextElementEnumerator(text ?? "");
        while (enumerator.MoveNext()) elements.Add((string)enumerator.Current);
        lock (Gate)
        {
            Pending.Clear();
            foreach (string element in elements) Pending.Enqueue(element);
            SuppressedKeys.Clear();
            completed = 0;
            total = elements.Count;
            targetWindow = GetForegroundWindow();
            paused = false;
            armed = total > 0;
            haveMousePoint = GetCursorPos(out lastMousePoint);
        }
        Emit("START 0 " + elements.Count);
        if (elements.Count == 0) Finish();
    }

    static void Pause(string reason)
    {
        bool changed = false;
        lock (Gate)
        {
            if (armed && !paused)
            {
                paused = true;
                SuppressedKeys.Clear();
                changed = true;
            }
        }
        if (changed) Emit("PAUSED " + reason);
    }

    static void Resume()
    {
        bool changed = false;
        lock (Gate)
        {
            if (armed && paused)
            {
                targetWindow = GetForegroundWindow();
                paused = false;
                SuppressedKeys.Clear();
                haveMousePoint = GetCursorPos(out lastMousePoint);
                changed = true;
            }
        }
        if (changed) Emit("RESUMED");
    }

    static void Cancel(string reason)
    {
        bool changed = false;
        lock (Gate)
        {
            if (armed)
            {
                armed = false;
                paused = false;
                Pending.Clear();
                SuppressedKeys.Clear();
                changed = true;
            }
        }
        if (changed) Emit("CANCELLED " + reason);
    }

    static void Finish()
    {
        lock (Gate)
        {
            armed = false;
            paused = false;
            Pending.Clear();
            SuppressedKeys.Clear();
        }
        Emit("DONE");
    }

    static IntPtr KeyboardCallback(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code < 0) return CallNextHookEx(keyboardHook, code, wParam, lParam);
        KBDLLHOOKSTRUCT data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
        if ((data.flags & LLKHF_INJECTED) != 0)
            return CallNextHookEx(keyboardHook, code, wParam, lParam);

        int message = wParam.ToInt32();
        bool isDown = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
        bool isUp = message == WM_KEYUP || message == WM_SYSKEYUP;
        int key = unchecked((int)data.vkCode);
        bool active, isPaused;
        lock (Gate) { active = armed; isPaused = paused; }
        if (!active) return CallNextHookEx(keyboardHook, code, wParam, lParam);

        if (key == VK_F8)
        {
            if (isDown) { if (isPaused) Resume(); else Pause("operator"); }
            return new IntPtr(1);
        }
        if (key == VK_F9 || key == VK_ESCAPE)
        {
            if (isDown) Cancel(key == VK_F9 ? "operator" : "escape");
            return new IntPtr(1);
        }
        if (isPaused) return CallNextHookEx(keyboardHook, code, wParam, lParam);

        if (GetForegroundWindow() != targetWindow)
        {
            Pause("focus_changed");
            return CallNextHookEx(keyboardHook, code, wParam, lParam);
        }

        if (isUp)
        {
            lock (Gate) SuppressedKeys.Remove(key);
            return new IntPtr(1);
        }
        if (!isDown) return CallNextHookEx(keyboardHook, code, wParam, lParam);
        if (IsModifier(key))
        {
            lock (Gate) SuppressedKeys.Add(key);
            return new IntPtr(1);
        }

        string token = null;
        int nowCompleted = 0, nowTotal = 0;
        bool done = false;
        lock (Gate)
        {
            SuppressedKeys.Add(key);
            if (Pending.Count > 0)
            {
                token = Pending.Dequeue();
                completed++;
                nowCompleted = completed;
                nowTotal = total;
                done = Pending.Count == 0;
            }
        }
        if (token != null) SendToken(token);
        Emit("PROGRESS " + nowCompleted + " " + nowTotal);
        if (done) Finish();
        return new IntPtr(1);
    }

    static IntPtr MouseCallback(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code < 0) return CallNextHookEx(mouseHook, code, wParam, lParam);
        MSLLHOOKSTRUCT data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
        if ((data.flags & LLMHF_INJECTED) != 0)
            return CallNextHookEx(mouseHook, code, wParam, lParam);
        bool active, isPaused;
        lock (Gate) { active = armed; isPaused = paused; }
        if (!active || isPaused) return CallNextHookEx(mouseHook, code, wParam, lParam);

        int message = wParam.ToInt32();
        bool button = message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN || message == WM_MBUTTONDOWN;
        bool moved = false;
        if (message == WM_MOUSEMOVE)
        {
            lock (Gate)
            {
                if (haveMousePoint)
                {
                    int dx = Math.Abs(data.pt.x - lastMousePoint.x);
                    int dy = Math.Abs(data.pt.y - lastMousePoint.y);
                    moved = dx + dy >= 4;
                }
                lastMousePoint = data.pt;
                haveMousePoint = true;
            }
        }
        if (button || moved) Pause(button ? "mouse_click" : "mouse_move");
        return CallNextHookEx(mouseHook, code, wParam, lParam);
    }

    static bool IsModifier(int key)
    {
        return key == 0x10 || key == 0x11 || key == 0x12 ||
               key == 0xA0 || key == 0xA1 || key == 0xA2 ||
               key == 0xA3 || key == 0xA4 || key == 0xA5 ||
               key == 0x5B || key == 0x5C;
    }

    static void SendToken(string token)
    {
        if (token == "\r" || token == "\n" || token == "\r\n") { SendVirtualKey(0x0D); return; }
        if (token == "\t") { SendVirtualKey(0x09); return; }
        if (token == "\b") { SendVirtualKey(0x08); return; }
        foreach (char unit in token)
        {
            INPUT[] inputs = new INPUT[2];
            inputs[0].type = INPUT_KEYBOARD;
            inputs[0].u.ki.wScan = unit;
            inputs[0].u.ki.dwFlags = KEYEVENTF_UNICODE;
            inputs[1].type = INPUT_KEYBOARD;
            inputs[1].u.ki.wScan = unit;
            inputs[1].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        }
    }

    static void SendVirtualKey(ushort key)
    {
        INPUT[] inputs = new INPUT[2];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].u.ki.wVk = key;
        inputs[1].type = INPUT_KEYBOARD;
        inputs[1].u.ki.wVk = key;
        inputs[1].u.ki.dwFlags = KEYEVENTF_KEYUP;
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    static void Emit(string message)
    {
        lock (OutputGate) { Console.WriteLine(message); Console.Out.Flush(); }
    }
    static string Safe(string value) { return (value ?? "unknown").Replace("\r", " ").Replace("\n", " "); }
    static void Cleanup()
    {
        if (keyboardHook != IntPtr.Zero) UnhookWindowsHookEx(keyboardHook);
        if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook);
    }

    delegate IntPtr LowLevelKeyboardProc(int code, IntPtr wParam, IntPtr lParam);
    delegate IntPtr LowLevelMouseProc(int code, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; }
    [StructLayout(LayoutKind.Sequential)] struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData, flags, time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }

    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, LowLevelKeyboardProc cb, IntPtr module, uint thread);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, LowLevelMouseProc cb, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG message);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG message);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, int message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)] static extern IntPtr GetModuleHandle(string name);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
}
'@

Add-Type -TypeDefinition $source -Language CSharp
[PairedTypingHost]::Run()
