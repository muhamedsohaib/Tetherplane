using System;
using System.IO;
using System.Drawing;
using System.Windows.Forms;
using System.Threading.Tasks;
using System.Text.RegularExpressions;
using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Web.WebView2.Core;

internal sealed class PrivateWebViewLab : Form
{
    private readonly string _profile;
    private readonly string _log;
    private WebView2 _web;
    private Timer _deadline;
    private bool _completed;

    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out NativePoint p);
    [StructLayout(LayoutKind.Sequential)] private struct NativePoint { public int X; public int Y; }

    public PrivateWebViewLab(string profile, string log)
    {
        _profile = profile;
        _log = log;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        FormBorderStyle = FormBorderStyle.None;
        Bounds = new Rectangle(-29000, -29000, 850, 650);
        TopMost = false;
        Opacity = 0;
        Text = "Tetherplane-WebView2-Disposable-Lab";
        _web = new WebView2();
        _web.Dock = DockStyle.Fill;
        Controls.Add(_web);
        _deadline = new Timer();
        _deadline.Interval = 22000;
        _deadline.Tick += (sender, args) => {
            Fail("TIMEOUT_WEBVIEW2_INITIALIZATION_OR_CDP");
        };
        Shown += async (sender, args) => { await PerformProbeAsync(); };
    }

    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
            cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW
            return cp;
        }
    }

    private void Say(string text)
    {
        File.AppendAllText(_log, text + Environment.NewLine);
    }

    private void Fail(string code)
    {
        if (_completed) return;
        _completed = true;
        Environment.ExitCode = 1;
        Say("RESULT=FAIL " + code);
        Close();
    }

    private async Task PerformProbeAsync()
    {
        if (_completed) return;
        _deadline.Start();
        long focusStart = GetForegroundWindow().ToInt64();
        uint clipboardStart = GetClipboardSequenceNumber();
        NativePoint cursorStart;
        GetCursorPos(out cursorStart);
        try
        {
            Say("HOST_UI=OFFSCREEN_NOACTIVATE");
            string installed = CoreWebView2Environment.GetAvailableBrowserVersionString();
            Say("RUNTIME_VERSION=" + installed);
            CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, _profile, null);
            await _web.EnsureCoreWebView2Async(env);
            Say("CORE_READY=true");
            CoreWebView2 core = _web.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.NewWindowRequested += (sender, args) => { args.Handled = true; };
            core.NavigationStarting += (sender, args) => {
                if (!(args.Uri == "about:blank" || args.Uri.StartsWith("data:", StringComparison.OrdinalIgnoreCase)))
                    args.Cancel = true;
            };
            TaskCompletionSource<bool> nav = new TaskCompletionSource<bool>();
            core.NavigationCompleted += (sender, args) => { nav.TrySetResult(args.IsSuccess); };
            core.NavigateToString("<!doctype html><html><body><button id='go' onclick=\"document.getElementById('status').textContent='clicked'\">GO</button><span id='status'>initial</span></body></html>");
            if (!await nav.Task) throw new Exception("LOCAL_HTML_NAVIGATION_FAILED");
            Say("LOCAL_HTML_READY=true");
            string initial = await core.CallDevToolsProtocolMethodAsync(
                "Runtime.evaluate",
                "{\"expression\":\"document.getElementById('status').textContent\",\"returnByValue\":true}");
            if (!Regex.IsMatch(initial, "\\\"value\\\"\\s*:\\s*\\\"initial\\\""))
                throw new Exception("INITIAL_CDP_VALUE_MISSING");
            Say("CDP_READ_OK=true");
            string action = await core.CallDevToolsProtocolMethodAsync(
                "Runtime.evaluate",
                "{\"expression\":\"document.getElementById('go').click()\",\"returnByValue\":true}");
            string result = await core.CallDevToolsProtocolMethodAsync(
                "Runtime.evaluate",
                "{\"expression\":\"document.getElementById('status').textContent\",\"returnByValue\":true}");
            if (!Regex.IsMatch(result, "\\\"value\\\"\\s*:\\s*\\\"clicked\\\""))
                throw new Exception("CDP_BROWSER_ACTION_NOT_VERIFIED");
            Say("CDP_ACTION_VERIFIED=true");
            await Task.Delay(3000);
            long focusEnd = GetForegroundWindow().ToInt64();
            uint clipboardEnd = GetClipboardSequenceNumber();
            NativePoint cursorEnd;
            GetCursorPos(out cursorEnd);
            Say("CURSOR_BASE=" + cursorStart.X + "," + cursorStart.Y);
            Say("CURSOR_END=" + cursorEnd.X + "," + cursorEnd.Y);
            Say("FOREGROUND_UNCHANGED=" + (focusStart == focusEnd).ToString());
            Say("CLIPBOARD_UNCHANGED=" + (clipboardStart == clipboardEnd).ToString());
            Say("CURSOR_UNCHANGED=" + (cursorStart.X == cursorEnd.X && cursorStart.Y == cursorEnd.Y).ToString());
            if (focusStart != focusEnd) throw new Exception("FOREGROUND_CHANGED");
            if (clipboardStart != clipboardEnd) throw new Exception("CLIPBOARD_CHANGED");
            if (cursorStart.X != cursorEnd.X || cursorStart.Y != cursorEnd.Y) throw new Exception("CURSOR_CHANGED");
            _completed = true;
            Say("RESULT=PASS");
        }
        catch (Exception ex)
        {
            Fail(ex.GetType().Name + ":" + ex.Message.Substring(0, Math.Min(220, ex.Message.Length)));
        }
        finally
        {
            _deadline.Stop();
            Close();
        }
    }

    [STAThread]
    public static void Main(string[] args)
    {
        if (args.Length != 2) { Environment.ExitCode = 2; return; }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new PrivateWebViewLab(args[0], args[1]));
    }
}
