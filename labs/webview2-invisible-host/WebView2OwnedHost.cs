// Review-only Windows WebView2 disposable fixture host.
// Fixed local-fixture stdin/stdout JSON commands with per-host capability and
// explicit short-lived lab activation. No listener, generic CDP, external
// navigation, filesystem operations, or human-browser attachment.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal sealed class WebView2OwnedHost : Form
{
    private const string FixtureHtml =
        "<!doctype html><html><body><button id='go' " +
        "onclick=\"document.getElementById('status').textContent='clicked'\">" +
        "GO</button><span id='status'>initial</span></body></html>";
    private const string ReadStatus =
        "{\"expression\":\"document.getElementById('status').textContent\",\"returnByValue\":true}";
    private const string ClickButton =
        "{\"expression\":\"document.getElementById('go').click()\",\"returnByValue\":true}";

    private readonly string _profile;
    private readonly JavaScriptSerializer _json = new JavaScriptSerializer();
    private readonly WebView2 _browser = new WebView2();
    private CoreWebView2 _core;
    private bool _created;
    private bool _closed;
    private bool _fixtureNavigating;
    private string _pageId;
    private int _revision;
    private bool _stopping;
    private readonly string _hostCapability = NewHostCapability();
    private readonly Stopwatch _grantClock = new Stopwatch();
    private long _grantLifetimeMs;
    private bool _grantActivated;
    private bool _grantRevoked;

    private bool GrantActive { get { return _grantActivated && !_grantRevoked &&
        _grantClock.IsRunning && _grantClock.ElapsedMilliseconds < _grantLifetimeMs; } }

    private WebView2OwnedHost(string profile)
    {
        _profile = profile;
        Text = "Tetherplane disposable WebView2 fixture";
        ShowInTaskbar = false;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Bounds = new Rectangle(-29000, -29000, 850, 650);
        Opacity = 0;
        TopMost = false;
        _browser.Dock = DockStyle.Fill;
        Controls.Add(_browser);
        Shown += async (sender, args) => { await StartAsync(); };
    }

    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
            cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW
            return cp;
        }
    }

    private async Task StartAsync()
    {
        try
        {
            var environment = await CoreWebView2Environment.CreateAsync(
                null, _profile, null);
            await _browser.EnsureCoreWebView2Async(environment);
            _core = _browser.CoreWebView2;
            _core.Settings.AreDevToolsEnabled = false;
            _core.Settings.AreDefaultContextMenusEnabled = false;
            _core.NewWindowRequested += (sender, args) => { args.Handled = true; };
            _core.PermissionRequested += (sender, args) => {
                args.State = CoreWebView2PermissionState.Deny;
            };
            _core.DownloadStarting += (sender, args) => { args.Cancel = true; };
            _core.NavigationStarting += (sender, args) => {
                if (args.Uri == "about:blank") return;
                if (_fixtureNavigating &&
                    args.Uri.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) return;
                args.Cancel = true;
            };
            // No fixture resource is allowed to reach an HTTP or HTTPS server.
            _core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            _core.WebResourceRequested += (sender, args) => {
                if (args.Request.Uri.StartsWith("http:", StringComparison.OrdinalIgnoreCase) ||
                    args.Request.Uri.StartsWith("https:", StringComparison.OrdinalIgnoreCase))
                {
                    args.Response = environment.CreateWebResourceResponse(
                        null, 403, "Forbidden", "Content-Type: text/plain");
                }
            };
            // Only the parent with the private stdout pipe can obtain this
            // process-local capability. It is never in argv, environment,
            // browser pages or diagnostic output.
            Send(new { ready = true, capability = _hostCapability });
            Task.Run(() => ReadRequestsAsync());
        }
        catch
        {
            // Do not emit exception details (which can include local paths).
            Send(new { ready = false, error = new { code = "provider_failure" } });
            Close();
        }
    }

    private async Task ReadRequestsAsync()
    {
        try
        {
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                if (line.Length > 4096)
                {
                    Send(new { id = "", error = new { code = "permission_denied" } });
                    continue;
                }
                var replyComplete = new TaskCompletionSource<bool>();
                try
                {
                    BeginInvoke(new Action(async () => {
                        try
                        {
                            await HandleRequestAsync(line);
                        }
                        catch
                        {
                            // Handler is its own failure boundary, not an
                            // uncaught async-void WinForms exception.
                            Send(new { id = "", error = new { code = "provider_failure" } });
                        }
                        finally
                        {
                            replyComplete.TrySetResult(true);
                        }
                    }));
                    await replyComplete.Task;
                }
                catch
                {
                    break;
                }
                if (_stopping) break;
            }
        }
        finally
        {
            try { BeginInvoke(new Action(() => Close())); } catch {}
        }
    }

    private async Task HandleRequestAsync(string line)
    {
        string id = "";
        try
        {
            var record = _json.DeserializeObject(line) as Dictionary<string, object>;
            if (record == null) { SendError(id, "permission_denied"); return; }
            object idValue, methodValue;
            if (!record.TryGetValue("id", out idValue) ||
                !(idValue is string) ||
                ((string)idValue).Length < 1 ||
                ((string)idValue).Length > 64 ||
                !record.TryGetValue("method", out methodValue) ||
                !(methodValue is string))
            {
                SendError(id, "permission_denied");
                return;
            }
            id = (string)idValue;
            string method = (string)methodValue;
            Dictionary<string, object> args = new Dictionary<string, object>();
            object argsValue;
            if (record.TryGetValue("args", out argsValue))
            {
                args = argsValue as Dictionary<string, object>;
                if (args == null) { SendError(id, "permission_denied"); return; }
            }

            if (!CapabilityMatches(_hostCapability, Arg(record, "capability")))
            {
                SendError(id, "permission_denied");
                return;
            }
            // Shutdown and closing an already-owned fixture stay available
            // after expiry so the parent can clean up safely.
            if (method != "activate_fixture" && method != "revoke_fixture" &&
                method != "shutdown" &&
                method != "close_fixture" && !GrantActive)
            {
                SendError(id, "permission_denied");
                return;
            }

            object data;
            switch (method)
            {
                case "activate_fixture":
                    if (_grantActivated || _grantRevoked || _created || _closed)
                        throw new NativeDenied("permission_denied");
                    object lifetime;
                    if (!args.TryGetValue("lifetime_ms", out lifetime) ||
                        (!(lifetime is int) && !(lifetime is long)))
                        throw new NativeDenied("permission_denied");
                    var duration = Convert.ToInt64(lifetime);
                    if (duration < 1000 || duration > 120000)
                        throw new NativeDenied("permission_denied");
                    _grantLifetimeMs = duration;
                    _grantActivated = true;
                    _grantClock.Start(); // monotonic, unaffected by wall-clock changes
                    data = new { active = true };
                    break;
                case "revoke_fixture":
                    // A native host may not be reactivated after revocation.
                    // The authenticated parent retains only cleanup/stop access.
                    _grantRevoked = true;
                    data = new { revoked = true };
                    break;
                case "create_fixture":
                    data = await CreateFixtureAsync();
                    break;
                case "observe_fixture":
                    CheckOwned(args);
                    data = await ObserveFixtureAsync();
                    break;
                case "click_fixture":
                    CheckOwned(args);
                    if (Arg(args, "element") != "go")
                        throw new NativeDenied("permission_denied");
                    data = await ClickFixtureAsync();
                    break;
                case "close_fixture":
                    CheckOwned(args);
                    _pageId = null;
                    _closed = true;
                    _browser.Dispose();
                    data = new { closed = true };
                    break;
                case "shutdown":
                    _stopping = true;
                    data = new { stopping = true };
                    break;
                default:
                    throw new NativeDenied("capability_unavailable");
            }
            Send(new { id = id, data = data });
        }
        catch (NativeDenied denied)
        {
            SendError(id, denied.Code);
        }
        catch
        {
            SendError(id, "provider_failure");
        }
    }

    private async Task<object> CreateFixtureAsync()
    {
        if (_created || _closed) throw new NativeDenied("permission_denied");
        _created = true; // Reserve before asynchronous navigation.
        var completion = new TaskCompletionSource<bool>();
        EventHandler<CoreWebView2NavigationCompletedEventArgs> handler = null;
        handler = (sender, args) => {
            _core.NavigationCompleted -= handler;
            completion.TrySetResult(args.IsSuccess);
        };
        _core.NavigationCompleted += handler;
        try
        {
            _fixtureNavigating = true;
            _core.NavigateToString(FixtureHtml);
            var finished = await Task.WhenAny(completion.Task, Task.Delay(8000));
            if (finished != completion.Task || !completion.Task.Result)
                throw new NativeDenied("provider_failure");
            var state = await ReadFixtureStatusAsync();
            if (state != "initial") throw new NativeDenied("provider_failure");
            if (!GrantActive)
                throw new NativeDenied("permission_denied");
            _pageId = "wvlab:" + Guid.NewGuid().ToString("N");
            _revision = 1;
            return new { page_id = _pageId, url = "about:blank" };
        }
        finally
        {
            _fixtureNavigating = false;
            _core.NavigationCompleted -= handler;
        }
    }

    private async Task<object> ObserveFixtureAsync()
    {
        var state = await ReadFixtureStatusAsync();
        if (state != "initial" && state != "clicked")
            throw new NativeDenied("provider_failure");
        return new {
            page_id = _pageId,
            url = "about:blank",
            status = state,
            revision = _revision,
        };
    }

    private async Task<object> ClickFixtureAsync()
    {
        if (await ReadFixtureStatusAsync() != "initial")
            throw new NativeDenied("permission_denied");
        await _core.CallDevToolsProtocolMethodAsync("Runtime.evaluate", ClickButton);
        if (await ReadFixtureStatusAsync() != "clicked")
            throw new NativeDenied("provider_failure");
        _revision++;
        return new { clicked = true };
    }

    private async Task<string> ReadFixtureStatusAsync()
    {
        var raw = await _core.CallDevToolsProtocolMethodAsync("Runtime.evaluate", ReadStatus);
        var top = _json.DeserializeObject(raw) as Dictionary<string, object>;
        object result;
        if (top == null || !top.TryGetValue("result", out result))
            throw new NativeDenied("provider_failure");
        var payload = result as Dictionary<string, object>;
        object value;
        if (payload == null || !payload.TryGetValue("value", out value) || !(value is string))
            throw new NativeDenied("provider_failure");
        return (string)value;
    }

    private void CheckOwned(Dictionary<string, object> args)
    {
        if (_closed || _pageId == null || Arg(args, "page_id") != _pageId)
            throw new NativeDenied("permission_denied");
    }

    private static string NewHostCapability()
    {
        var secret = new byte[32];
        using (var rng = RandomNumberGenerator.Create())
            rng.GetBytes(secret);
        return BitConverter.ToString(secret).Replace("-", "").ToLowerInvariant();
    }

    private static bool CapabilityMatches(string expected, string supplied)
    {
        if (supplied == null || expected == null || expected.Length != supplied.Length)
            return false;
        int difference = 0;
        for (int i = 0; i < expected.Length; i++)
            difference |= expected[i] ^ supplied[i];
        return difference == 0;
    }

    private static string Arg(Dictionary<string, object> args, string name)
    {
        object result;
        return args.TryGetValue(name, out result) ? result as string : null;
    }

    private void SendError(string id, string code)
    {
        Send(new { id = id, error = new { code = code } });
    }

    private void Send(object value)
    {
        Console.Out.WriteLine(_json.Serialize(value));
        Console.Out.Flush();
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        _stopping = true;
        try { _browser.Dispose(); } catch {}
        base.OnFormClosed(e);
    }

    [STAThread]
    public static void Main(string[] args)
    {
        if (args.Length != 1 || !Path.IsPathRooted(args[0]))
        {
            Environment.ExitCode = 2;
            return;
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new WebView2OwnedHost(args[0]));
    }

    private sealed class NativeDenied : Exception
    {
        public readonly string Code;
        public NativeDenied(string code) { Code = code; }
    }
}
