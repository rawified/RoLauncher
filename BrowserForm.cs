using System.Diagnostics;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace RoLauncher;

/// <summary>
/// A small in-app browser for roblox.com pages (sign-in, item pages, profiles).
/// It shares the launcher's WebView2 profile, so a sign-in here is remembered.
/// Links that leave roblox.com open in the default browser instead.
/// </summary>
public sealed class BrowserForm : Form
{
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(17, 18, 22) };
    private readonly CoreWebView2Environment _env;
    private readonly string _startUrl;

    public CoreWebView2? Core => _web.CoreWebView2;
    public event Action<BrowserForm>? Ready;

    public BrowserForm(CoreWebView2Environment env, string url, string title)
    {
        _env = env;
        _startUrl = url;
        Text = title;
        Size = new Size(1100, 780);
        MinimumSize = new Size(480, 520);
        StartPosition = FormStartPosition.CenterParent;
        BackColor = Color.FromArgb(17, 18, 22);
        var icon = Path.Combine(AppContext.BaseDirectory, "wwwroot", "icon.ico");
        if (File.Exists(icon)) Icon = new Icon(icon);
        Controls.Add(_web);
        Load += async (_, _) => await InitAsync();
    }

    private async Task InitAsync()
    {
        await _web.EnsureCoreWebView2Async(_env);
        var core = _web.CoreWebView2;
        core.Settings.IsStatusBarEnabled = false;
        core.DocumentTitleChanged += (_, _) => { if (!string.IsNullOrWhiteSpace(core.DocumentTitle)) Text = core.DocumentTitle; };
        core.NavigationStarting += (_, e) =>
        {
            if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var u)) return;
            if (u.Scheme is "roblox" or "roblox-player")
            {
                // "Play" buttons on roblox.com: let the main window handle game launches.
                e.Cancel = true;
                return;
            }
            if ((u.Scheme == "https" || u.Scheme == "http") && !RobloxClient.IsRobloxHost(new Uri("https://" + u.Host)) && e.IsUserInitiated)
            {
                e.Cancel = true;
                Process.Start(new ProcessStartInfo(u.ToString()) { UseShellExecute = true });
            }
        };
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var u) && RobloxClient.IsRobloxHost(new Uri("https://" + u.Host)))
                core.Navigate(u.ToString());
            else if (u is not null && (u.Scheme == "https" || u.Scheme == "http"))
                Process.Start(new ProcessStartInfo(u.ToString()) { UseShellExecute = true });
        };
        core.Navigate(_startUrl);
        Ready?.Invoke(this);
    }
}
