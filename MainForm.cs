using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace RoLauncher;

/// <summary>
/// Borderless window hosting the HTML UI in WebView2. The page talks to this
/// host through postMessage: { id, type, ... } -> { id, ok, data | error }.
/// Host-initiated events are sent as { evt, ... }.
/// </summary>
public sealed class MainForm : Form
{
    private const int ResizeBorder = 6;
    private int _titleBarCss = 40; // top bar height in CSS px; the Console interface reports 64

    private readonly WebView2 _web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(17, 18, 22) };
    private readonly Dictionary<long, RobloxClient> _clients = new();
    private readonly RobloxClient _anonymous = new();
    private RobloxClient _roblox;                    // client for the active account (or anonymous)
    private AccountStore? _accounts;
    private CoreWebView2Environment? _env;

    private readonly Dictionary<int, GameSession> _sessions = new();
    private int _nextSid;
    private int _embeddedSid;
    private IntPtr _embedded;
    private long _embeddedOldStyle;
    private Mutex? _singleton;                       // held to let several Roblox clients run at once
    private readonly DiscordRpc _discord = new();
    private string _closeBehavior = "ask";           // what to do with running games when the launcher closes: ask | close | keep

    public MainForm()
    {
        _roblox = _anonymous;
        Text = "RoLauncher";
        FormBorderStyle = FormBorderStyle.None;
        BackColor = Color.FromArgb(24, 25, 30);
        Padding = new Padding(4);
        MinimumSize = new Size(1000, 640);
        Size = new Size(1400, 860);
        StartPosition = FormStartPosition.CenterScreen;
        DoubleBuffered = true;
        var icon = Path.Combine(AppContext.BaseDirectory, "wwwroot", "icon.ico");
        if (File.Exists(icon)) Icon = new Icon(icon);

        Controls.Add(_web);

        _discord.StatusChanged += (status, detail) => Emit(new { evt = "discord", status, detail });
        Load += async (_, _) => await InitWebViewAsync();
        Resize += (_, _) =>
        {
            Padding = WindowState == FormWindowState.Maximized ? new Padding(0) : new Padding(4);
            FitEmbedded();
            Emit(new { evt = "windowState", state = WindowState.ToString() });
        };
        FormClosing += (_, e) =>
        {
            if (!ConfirmCloseWithGames(e)) { e.Cancel = true; return; }
            // Never take a game window down with us by accident: it is either closed above or released here.
            ReleaseEmbedded();
            foreach (var s in _sessions.Values) s.Dispose();
            SetMultiInstance(false);
            _discord.Dispose();
        };
    }

    private async Task InitWebViewAsync()
    {
        var dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RoLauncher");
        _accounts = new AccountStore(dataDir);
        _env = await CoreWebView2Environment.CreateAsync(null, dataDir);
        await _web.EnsureCoreWebView2Async(_env);

        var core = _web.CoreWebView2;
        core.Settings.IsNonClientRegionSupportEnabled = true; // enables CSS app-region: drag
        core.Settings.AreDefaultContextMenusEnabled = Debugger.IsAttached;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.SetVirtualHostNameToFolderMapping("app.rolauncher", Path.Combine(AppContext.BaseDirectory, "wwwroot"),
            CoreWebView2HostResourceAccessKind.Allow);
        core.WebMessageReceived += OnWebMessage;
        core.NavigationStarting += (_, _) => _titleBarCss = 40; // each interface reports its own
        core.NewWindowRequested += (_, e) => { e.Handled = true; OpenUrl(e.Uri); };

        await RestoreAccountsAsync();
        var args = Environment.GetCommandLineArgs();
        var page = Array.IndexOf(args, "--page") is var i and >= 0 && i + 1 < args.Length ? "#" + Uri.EscapeDataString(args[i + 1]) : "";
        core.Navigate("https://app.rolauncher/index.html" + page);
    }

    // ---------- Bridge ----------

    private async void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        JsonNode? msg;
        try { msg = JsonNode.Parse(e.WebMessageAsJson); } catch { return; }
        if (msg is null) return;

        var id = msg["id"]?.GetValue<int>() ?? 0;
        var type = msg["type"]?.GetValue<string>() ?? "";
        try
        {
            object? data = type switch
            {
                "fetch" => await ProxyFetchAsync(msg),
                "account" => await _roblox.GetAuthenticatedUserAsync(),
                "accounts" => AccountsPayload(),
                "login" or "addAccount" => await AddAccountAsync(),
                "switchAccount" => await SwitchAccountAsync(GetLong(msg, "accountId")),
                "removeAccount" => await RemoveAccountAsync(GetLong(msg, "accountId"), msg["signOut"]?.GetValue<bool>() ?? false),
                "logout" => await RemoveAccountAsync(_accounts?.Active?.Id ?? 0, signOut: true),
                "launch" => await LaunchAsync(msg),
                "leaveGame" => LeaveGame(msg["sid"]?.GetValue<int>()),
                "multiInstance" => SetMultiInstance(msg["enabled"]?.GetValue<bool>() ?? false),
                "discordConfig" => DiscordConfig(msg),
                "closeBehavior" => _closeBehavior = msg["mode"]?.GetValue<string>() is "close" or "keep" ? msg["mode"]!.GetValue<string>() : "ask",
                "discordActivity" => DiscordActivity(msg),
                "open" => OpenUrl(msg["url"]?.GetValue<string>()),
                "window" => WindowCommand(msg["action"]?.GetValue<string>()),
                "layout" => SetLayout(msg["titleBar"]?.GetValue<int>() ?? 40),
                "appInfo" => Updater.Info(),
                "checkUpdate" => await Updater.CheckAsync(),
                "installUpdate" => await InstallUpdateAsync(msg["url"]?.GetValue<string>() ?? ""),
                _ => throw new InvalidOperationException($"Unknown message type '{type}'")
            };
            Emit(new { id, ok = true, data });
        }
        catch (Exception ex)
        {
            Emit(new { id, ok = false, error = ex.Message });
        }
    }

    private static long GetLong(JsonNode msg, string key) =>
        long.TryParse(msg[key]?.ToString(), out var v) ? v : throw new ArgumentException($"{key} missing");

    private void Emit(object payload)
    {
        if (InvokeRequired) { BeginInvoke(() => Emit(payload)); return; }
        _web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(payload));
    }

    private async Task<JsonNode?> ProxyFetchAsync(JsonNode msg)
    {
        var url = msg["url"]?.GetValue<string>() ?? throw new ArgumentException("url missing");
        var method = msg["method"]?.GetValue<string>()?.ToUpperInvariant() switch
        {
            "POST" => HttpMethod.Post,
            "PATCH" => HttpMethod.Patch,
            _ => HttpMethod.Get
        };
        return await _roblox.GetJsonAsync(method, url, msg["body"]?.DeepClone());
    }

    // ---------- Accounts ----------

    private RobloxClient ClientFor(SavedAccount acc)
    {
        if (!_clients.TryGetValue(acc.Id, out var c))
        {
            c = new RobloxClient();
            _clients[acc.Id] = c;
        }
        c.SetCookie(acc.Cookie);
        return c;
    }

    private object AccountsPayload() => new
    {
        activeId = _accounts?.Active?.Id ?? 0,
        accounts = (_accounts?.Accounts ?? []).Select(a => new { id = a.Id, name = a.Name, displayName = a.DisplayName }).ToList()
    };

    /// <summary>On startup: use the saved active account, or adopt an existing roblox.com sign-in from earlier versions.</summary>
    private async Task RestoreAccountsAsync()
    {
        var store = _accounts!;
        if (store.Accounts.Count == 0)
        {
            var cookie = await GetBrowserCookieAsync(_web.CoreWebView2);
            if (cookie is not null)
            {
                var probe = new RobloxClient();
                probe.SetCookie(cookie);
                if (await probe.GetAuthenticatedUserAsync() is JsonNode u)
                    store.Upsert(ToAccount(u, cookie), makeActive: true);
            }
        }
        if (store.Active is { } active)
        {
            _roblox = ClientFor(active);
            SetBrowserCookie(active.Cookie);
        }
    }

    private static SavedAccount ToAccount(JsonNode u, string cookie) => new()
    {
        Id = u["id"]!.GetValue<long>(),
        Name = u["name"]?.GetValue<string>() ?? "",
        DisplayName = u["displayName"]?.GetValue<string>() ?? "",
        Cookie = cookie
    };

    private static async Task<string?> GetBrowserCookieAsync(CoreWebView2 core) =>
        (await core.CookieManager.GetCookiesAsync("https://www.roblox.com")).FirstOrDefault(c => c.Name == ".ROBLOSECURITY")?.Value;

    /// <summary>Puts one account's session into the shared WebView2 profile (used by roblox.com windows).</summary>
    private void SetBrowserCookie(string? cookie)
    {
        var cm = _web.CoreWebView2.CookieManager;
        cm.DeleteCookies(".ROBLOSECURITY", "https://www.roblox.com");
        cm.DeleteCookiesWithDomainAndPath(".ROBLOSECURITY", ".roblox.com", "/");
        if (cookie is null) return;
        var c = cm.CreateCookie(".ROBLOSECURITY", cookie, ".roblox.com", "/");
        c.IsHttpOnly = true;
        c.IsSecure = true;
        c.Expires = DateTime.Now.AddYears(1);
        cm.AddOrUpdateCookie(c);
    }

    /// <summary>Opens roblox.com/login (signed out locally, other accounts stay valid) and stores the new account.</summary>
    private async Task<JsonNode?> AddAccountAsync()
    {
        if (_env is null || _accounts is null) throw new InvalidOperationException("Not ready yet");
        var previous = _accounts.Active;
        SetBrowserCookie(null); // local only: the other sessions are NOT signed out on Roblox's side

        var done = new TaskCompletionSource<JsonNode?>();
        var form = new BrowserForm(_env, "https://www.roblox.com/login", "Add a Roblox account");
        var timer = new System.Windows.Forms.Timer { Interval = 1000 };
        var checking = false;
        timer.Tick += async (_, _) =>
        {
            if (form.Core is null || done.Task.IsCompleted || checking) return;
            checking = true;
            try
            {
                var cookie = await GetBrowserCookieAsync(form.Core);
                if (cookie is null) return;
                var probe = new RobloxClient();
                probe.SetCookie(cookie);
                if (await probe.GetAuthenticatedUserAsync() is not JsonNode user) return;
                timer.Stop();
                var acc = ToAccount(user, cookie);
                _accounts.Upsert(acc, makeActive: true);
                _roblox = ClientFor(acc);
                done.TrySetResult(user);
                form.Close();
            }
            finally { checking = false; }
        };
        form.FormClosed += (_, _) =>
        {
            timer.Dispose();
            if (!done.Task.IsCompleted && previous is not null) SetBrowserCookie(previous.Cookie); // cancelled
            done.TrySetResult(null);
        };
        timer.Start();
        form.Show(this);
        return await done.Task;
    }

    private async Task<JsonNode?> SwitchAccountAsync(long accountId)
    {
        var acc = _accounts?.Get(accountId) ?? throw new InvalidOperationException("Unknown account");
        var client = ClientFor(acc);
        var user = await client.GetAuthenticatedUserAsync()
                   ?? throw new InvalidOperationException($"{acc.DisplayName}'s session expired. Remove it and add it again.");
        _accounts!.SetActive(acc.Id);
        _roblox = client;
        SetBrowserCookie(acc.Cookie);
        return user;
    }

    private async Task<object> RemoveAccountAsync(long accountId, bool signOut)
    {
        var acc = _accounts?.Get(accountId);
        if (acc is null) return AccountsPayload();
        if (signOut) await ClientFor(acc).LogoutAsync(); // ends that session on Roblox's side
        _clients.Remove(acc.Id);
        var wasActive = _accounts!.Active?.Id == acc.Id;
        _accounts.Remove(acc.Id);
        if (wasActive)
        {
            var next = _accounts.Active;
            _roblox = next is null ? _anonymous : ClientFor(next);
            SetBrowserCookie(next?.Cookie);
        }
        return AccountsPayload();
    }

    // ---------- Discord Rich Presence ----------

    private object DiscordConfig(JsonNode msg)
    {
        _discord.Configure(msg["enabled"]?.GetValue<bool>() ?? false, msg["clientId"]?.GetValue<string>());
        return new { status = _discord.Status };
    }

    private object DiscordActivity(JsonNode msg)
    {
        _discord.SetActivity(msg["activity"]?.DeepClone() as JsonObject);
        return true;
    }

    // ---------- Multiple Roblox instances ----------

    private object SetMultiInstance(bool on)
    {
        if (on && _singleton is null)
        {
            var m = new Mutex(true, "ROBLOX_singletonMutex", out var createdNew);
            if (!createdNew)
            {
                m.Dispose();
                return new { enabled = false, warning = "Close every Roblox window first, then turn this on again." };
            }
            _singleton = m;
        }
        else if (!on && _singleton is not null)
        {
            try { _singleton.ReleaseMutex(); } catch { /* not owned */ }
            _singleton.Dispose();
            _singleton = null;
        }
        return new { enabled = _singleton is not null };
    }

    // ---------- Launching ----------

    private async Task<object> LaunchAsync(JsonNode msg)
    {
        var placeId = msg["placeId"]?.ToString() ?? "";
        if (!long.TryParse(placeId, out var pid) || pid <= 0) throw new ArgumentException("Invalid place id");
        Guid? job = Guid.TryParse(msg["jobId"]?.GetValue<string>(), out var g) ? g : null;
        // Private servers: accessCode (from the server list) or linkCode (from an invite link).
        var accessCode = SafeCode(msg["accessCode"]?.GetValue<string>());
        var linkCode = SafeCode(msg["linkCode"]?.GetValue<string>());
        var opts = new LaunchOptions(
            Embed: msg["embed"]?.GetValue<bool>() ?? true,
            CloseOnLeave: msg["closeOnLeave"]?.GetValue<bool>() ?? true,
            MinimizeLauncher: msg["minimize"]?.GetValue<bool>() ?? true);

        // Which account plays: the one asked for, else the active one, else the Roblox app's own sign-in.
        var acc = long.TryParse(msg["accountId"]?.ToString(), out var aid) && aid > 0 ? _accounts?.Get(aid) : _accounts?.Active;

        if (_singleton is null)
            foreach (var s in _sessions.Values.Where(s => s.IsRunning).ToList()) s.Kill(); // single instance: replace

        string uri;
        if (acc is not null)
        {
            var ticket = await ClientFor(acc).GetAuthTicketAsync();
            var tracker = Random.Shared.NextInt64(100_000_000_000, 999_999_999_999);
            var launcherUrl =
                accessCode is not null || linkCode is not null
                    ? $"https://www.roblox.com/Game/PlaceLauncher.ashx?request=RequestPrivateGame&browserTrackerId={tracker}&placeId={pid}" +
                      (accessCode is not null ? $"&accessCode={accessCode}" : "") + (linkCode is not null ? $"&linkCode={linkCode}" : "") +
                      $"&joinAttemptId={Guid.NewGuid()}&joinAttemptOrigin=PrivateServerListJoin"
                : job is null
                    ? $"https://www.roblox.com/Game/PlaceLauncher.ashx?request=RequestGame&browserTrackerId={tracker}&placeId={pid}&isPlayTogetherGame=false&joinAttemptId={Guid.NewGuid()}&joinAttemptOrigin=PlayButton"
                    : $"https://www.roblox.com/Game/PlaceLauncher.ashx?request=RequestGameJob&browserTrackerId={tracker}&placeId={pid}&gameId={job}&isPlayTogetherGame=false&joinAttemptId={Guid.NewGuid()}&joinAttemptOrigin=JoinUser";
            uri = $"roblox-player:1+launchmode:play+gameinfo:{ticket}+launchtime:{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}" +
                  $"+placelauncherurl:{Uri.EscapeDataString(launcherUrl)}+browsertrackerid:{tracker}+robloxLocale:en_us+gameLocale:en_us";
        }
        else
        {
            uri = $"roblox://experiences/start?placeId={pid}"
                  + (accessCode is not null ? $"&accessCode={accessCode}" : linkCode is not null ? $"&linkCode={linkCode}" : job is null ? "" : $"&gameInstanceId={job}");
        }

        var sid = StartSession(opts, acc?.Id ?? 0);
        try
        {
            Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true });
        }
        catch (System.ComponentModel.Win32Exception)
        {
            if (_sessions.Remove(sid, out var dead)) dead.Dispose();
            throw new InvalidOperationException("Roblox doesn't seem to be installed (roblox-player protocol not registered).");
        }
        return new { sid, accountId = acc?.Id ?? 0, multi = _singleton is not null };
    }

    /// <summary>Private-server codes are GUIDs or short tokens; reject anything else so it can't alter the URL.</summary>
    private static string? SafeCode(string? code) =>
        string.IsNullOrWhiteSpace(code) ? null
        : code.Length <= 128 && code.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_') ? code
        : throw new ArgumentException("Invalid private server code");

    private int StartSession(LaunchOptions opts, long accountId)
    {
        var sid = ++_nextSid;
        var session = new GameSession(opts);
        _sessions[sid] = session;
        session.Changed += (state, data) => BeginInvoke(() => OnSessionChanged(sid, accountId, session, state, data));
        session.Start();
        return sid;
    }

    private void OnSessionChanged(int sid, long accountId, GameSession session, string state, Dictionary<string, object?> data)
    {
        switch (state)
        {
            case "window":
                if (session.Options.Embed && _embedded == IntPtr.Zero) { Embed(session.GameWindow); _embeddedSid = sid; }
                else if (session.Options.MinimizeLauncher && _embedded == IntPtr.Zero) WindowState = FormWindowState.Minimized;
                break;
            case "ended":
            case "failed":
                if (_embeddedSid == sid) { ReleaseEmbedded(); _embeddedSid = 0; }
                _sessions.Remove(sid);
                session.Dispose();
                if (_sessions.Count == 0) BringLauncherBack();
                break;
        }
        data["evt"] = "game";
        data["state"] = state;
        data["sid"] = sid;
        data["accountId"] = accountId;
        data["embedded"] = _embeddedSid == sid && _embedded != IntPtr.Zero;
        Emit(data);
    }

    /// <summary>
    /// Closing the launcher while Roblox is running: ask (default), or follow the saved choice.
    /// Returns false when the user cancels closing.
    /// </summary>
    private bool ConfirmCloseWithGames(FormClosingEventArgs e)
    {
        var running = _sessions.Values.Where(s => s.IsRunning).ToList();
        if (running.Count == 0 || e.CloseReason == CloseReason.WindowsShutDown) return true;

        var mode = _closeBehavior;
        if (mode == "ask")
        {
            var closeGames = new TaskDialogButton(running.Count > 1 ? "Close the games too" : "Close the game too");
            var keep = new TaskDialogButton("Keep playing");
            var page = new TaskDialogPage
            {
                Caption = "RoLauncher",
                Heading = running.Count > 1 ? $"{running.Count} Roblox games are still running" : "Roblox is still running",
                Text = "Close RoLauncher and the game, or close only RoLauncher and keep playing?",
                Icon = TaskDialogIcon.Information,
                Buttons = { closeGames, keep, TaskDialogButton.Cancel },
                DefaultButton = closeGames,
                Verification = new TaskDialogVerificationCheckBox("Remember my choice"),
                AllowCancel = true
            };
            var result = TaskDialog.ShowDialog(this, page);
            if (result == closeGames) mode = "close";
            else if (result == keep) mode = "keep";
            else return false;

            if (page.Verification.Checked)
            {
                _closeBehavior = mode;
                Emit(new { evt = "closeBehavior", mode }); // the page saves it in Settings
            }
        }

        if (mode == "close")
        {
            ReleaseEmbedded();
            foreach (var s in running) s.Kill();
        }
        return true;
    }

    private object LeaveGame(int? sid)
    {
        if (sid is int one) { if (_sessions.TryGetValue(one, out var s)) s.Kill(); }
        else foreach (var s in _sessions.Values) s.Kill();
        return true;
    }

    private void BringLauncherBack()
    {
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Show();
        // Windows blocks focus-stealing; a brief TopMost flip reliably brings us forward.
        TopMost = true;
        Activate();
        TopMost = false;
        SetForegroundWindow(Handle);
    }

    // ---------- "Playing inside the launcher" ----------
    // Roblox only accepts mouse/keyboard input while its own window is the active
    // (foreground) window, and a child window inside another program can never be that.
    // So instead of re-parenting, the Roblox window stays top-level but becomes borderless,
    // is *owned* by the launcher (always above it, minimizes with it) and is kept pinned
    // over the launcher's content area.

    private Rectangle GameAreaOnScreen()
    {
        var top = (int)Math.Round(_titleBarCss * DeviceDpi / 96.0);
        var r = new Rectangle(Padding.Left, Padding.Top + top,
            Math.Max(1, ClientSize.Width - Padding.Horizontal), Math.Max(1, ClientSize.Height - Padding.Vertical - top));
        return RectangleToScreen(r);
    }

    private void Embed(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return;
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;

        ShowWindow(hwnd, SW_RESTORE); // Roblox often opens maximized
        _embeddedOldStyle = GetWindowLongPtr(hwnd, GWL_STYLE).ToInt64();
        var style = _embeddedOldStyle & ~(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
        SetWindowLongPtr(hwnd, GWL_STYLE, new IntPtr(style));
        SetWindowLongPtr(hwnd, GWLP_HWNDPARENT, Handle); // owner, not parent
        _embedded = hwnd;
        FitEmbedded();
        SetForegroundWindow(hwnd);
    }

    private void FitEmbedded()
    {
        if (_embedded == IntPtr.Zero || WindowState == FormWindowState.Minimized) return;
        if (!IsWindow(_embedded)) { _embedded = IntPtr.Zero; return; }
        var r = GameAreaOnScreen();
        SetWindowPos(_embedded, IntPtr.Zero, r.X, r.Y, r.Width, r.Height, SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    }

    private void ReleaseEmbedded()
    {
        if (_embedded != IntPtr.Zero && IsWindow(_embedded))
        {
            SetWindowLongPtr(_embedded, GWLP_HWNDPARENT, IntPtr.Zero);
            SetWindowLongPtr(_embedded, GWL_STYLE, new IntPtr(_embeddedOldStyle));
            var r = Bounds;
            SetWindowPos(_embedded, IntPtr.Zero, r.X + 40, r.Y + 40, Math.Max(800, r.Width - 80), Math.Max(600, r.Height - 80),
                SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        }
        _embedded = IntPtr.Zero;
    }

    // ---------- Misc ----------

    private object OpenUrl(string? url)
    {
        if (url is null || !Uri.TryCreate(url, UriKind.Absolute, out var u) || (u.Scheme != "https" && u.Scheme != "http"))
            throw new ArgumentException("Invalid url");
        if (_env is not null && RobloxClient.IsRobloxHost(new Uri("https://" + u.Host)))
            new BrowserForm(_env, u.ToString(), "Roblox").Show(this);
        else
            Process.Start(new ProcessStartInfo(u.ToString()) { UseShellExecute = true });
        return true;
    }

    private async Task<object> InstallUpdateAsync(string url)
    {
        await Updater.InstallAsync(url, p => BeginInvoke(() => Emit(new { evt = "updateProgress", progress = p })));
        // The setup waits for this window to close before it replaces the files.
        BeginInvoke(Close);
        return true;
    }

    private object SetLayout(int titleBar)
    {
        _titleBarCss = Math.Clamp(titleBar, 0, 200);
        FitEmbedded();
        return true;
    }

    private object WindowCommand(string? action)
    {
        switch (action)
        {
            case "minimize": WindowState = FormWindowState.Minimized; break;
            case "maximize": WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized; break;
            case "close": Close(); break;
        }
        return WindowState.ToString();
    }

    // ---------- Borderless window plumbing ----------

    protected override void OnMove(EventArgs e)
    {
        base.OnMove(e);
        FitEmbedded();
        var scr = Screen.FromHandle(Handle);
        var wa = scr.WorkingArea;
        MaximizedBounds = new Rectangle(wa.X - scr.Bounds.X, wa.Y - scr.Bounds.Y, wa.Width, wa.Height);
    }

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.Style |= 0x00020000; // WS_MINIMIZEBOX -> taskbar click minimizes
            return cp;
        }
    }

    protected override void WndProc(ref Message m)
    {
        const int WM_NCHITTEST = 0x84;
        base.WndProc(ref m);
        if (m.Msg != WM_NCHITTEST || WindowState == FormWindowState.Maximized) return;

        var p = PointToClient(new Point(unchecked((short)(long)m.LParam), unchecked((short)((long)m.LParam >> 16))));
        bool l = p.X <= ResizeBorder, r = p.X >= ClientSize.Width - ResizeBorder;
        bool t = p.Y <= ResizeBorder, b = p.Y >= ClientSize.Height - ResizeBorder;
        if (t && l) m.Result = 13;
        else if (t && r) m.Result = 14;
        else if (b && l) m.Result = 16;
        else if (b && r) m.Result = 17;
        else if (l) m.Result = 10;
        else if (r) m.Result = 11;
        else if (t) m.Result = 12;
        else if (b) m.Result = 15;
    }

    private const int GWL_STYLE = -16, GWLP_HWNDPARENT = -8, SW_RESTORE = 9;
    private const uint SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010, SWP_FRAMECHANGED = 0x0020;
    private const long WS_POPUP = 0x80000000, WS_CHILD = 0x40000000, WS_VISIBLE = 0x10000000, WS_CAPTION = 0x00C00000,
        WS_THICKFRAME = 0x00040000, WS_SYSMENU = 0x00080000, WS_MINIMIZEBOX = 0x00020000, WS_MAXIMIZEBOX = 0x00010000;

    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] private static extern IntPtr GetWindowLongPtr(IntPtr h, int idx);
    [DllImport("user32.dll")] private static extern IntPtr SetWindowLongPtr(IntPtr h, int idx, IntPtr value);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr h);
}
