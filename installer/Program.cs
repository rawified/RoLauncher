using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using Microsoft.Win32;

namespace RoLauncherSetup;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        // "--update --wait <pid>": started by RoLauncher's updater. Updates the installed copy without questions.
        var update = args.Contains("--update");
        var i = Array.IndexOf(args, "--wait");
        var waitPid = i >= 0 && i + 1 < args.Length && int.TryParse(args[i + 1], out var pid) ? pid : 0;
        Application.Run(new SetupForm(update, waitPid));
    }
}

/// <summary>
/// Per-user installer: no admin rights needed. Installs to %LOCALAPPDATA%\Programs\RoLauncher,
/// adds Start menu / desktop shortcuts and an "Installed apps" entry whose uninstall command
/// is "RoLauncher.exe --uninstall" (handled by the app itself).
/// </summary>
internal sealed class SetupForm : Form
{
    private const string AppKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\RoLauncher";
    private const string ShortcutName = "RoLauncher.lnk";
    private const string ExeName = "RoLauncher.exe";
    private const string WebView2Key = @"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

    private static readonly Color Bg = Color.FromArgb(17, 18, 22), Panel = Color.FromArgb(28, 30, 38),
        Text1 = Color.FromArgb(233, 234, 238), Muted = Color.FromArgb(139, 141, 152), Accent = Color.FromArgb(99, 102, 241);

    private readonly TextBox _path = new();
    private readonly CheckBox _desktop = new() { Text = "Create a desktop shortcut", Checked = true };
    private readonly CheckBox _launch = new() { Text = "Open RoLauncher when done", Checked = true };
    private readonly Button _install = new() { Text = "Install" };
    private readonly Button _browse = new() { Text = "Browse…" };
    private readonly ProgressBar _bar = new() { Visible = false };
    private readonly Label _status = new();
    private readonly LinkLabel _webview = new() { Visible = false };

    private readonly bool _auto;
    private readonly int _waitPid;

    public SetupForm(bool autoUpdate = false, int waitPid = 0)
    {
        _waitPid = waitPid;
        var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "1.0.0";
        Text = "Install RoLauncher";
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(560, 390);
        BackColor = Bg;
        ForeColor = Text1;
        Font = new Font("Segoe UI", 9.5f);
        AutoScaleMode = AutoScaleMode.Dpi;
        try { Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath!); } catch { }

        var logo = new PictureBox { Size = new Size(84, 84), Location = new Point(32, 30), SizeMode = PictureBoxSizeMode.Zoom };
        using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("logo.png"))
            if (s is not null) logo.Image = Image.FromStream(s);
        var title = new Label { Text = "RoLauncher", Font = new Font("Segoe UI Semibold", 20f), AutoSize = true, Location = new Point(132, 34) };
        var sub = new Label { Text = $"Version {version} · a launcher for Roblox", ForeColor = Muted, AutoSize = true, Location = new Point(135, 78) };

        var where = new Label { Text = "Install to", ForeColor = Muted, AutoSize = true, Location = new Point(32, 140) };
        _path.Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "RoLauncher");
        _path.SetBounds(32, 162, 400, 28);
        _path.BackColor = Panel; _path.ForeColor = Text1; _path.BorderStyle = BorderStyle.FixedSingle;
        Style(_browse, false);
        _browse.SetBounds(442, 160, 86, 30);
        _browse.Click += (_, _) =>
        {
            using var d = new FolderBrowserDialog { Description = "Choose where to install RoLauncher", UseDescriptionForTitle = true };
            if (d.ShowDialog(this) == DialogResult.OK) _path.Text = Path.Combine(d.SelectedPath, "RoLauncher");
        };

        foreach (var c in new[] { _desktop, _launch }) { c.ForeColor = Text1; c.AutoSize = true; }
        _desktop.Location = new Point(32, 206);
        _launch.Location = new Point(32, 232);

        _webview.SetBounds(32, 262, 496, 40);
        _webview.LinkColor = Color.FromArgb(129, 140, 248);
        _webview.ForeColor = Color.FromArgb(252, 211, 77);
        _webview.Text = "Microsoft Edge WebView2 Runtime wasn't found. RoLauncher needs it to show its screens. Get it from Microsoft (free)";
        _webview.LinkArea = new LinkArea(_webview.Text.IndexOf("Get it", StringComparison.Ordinal), "Get it from Microsoft".Length);
        _webview.LinkClicked += (_, _) => Process.Start(new ProcessStartInfo("https://developer.microsoft.com/microsoft-edge/webview2/") { UseShellExecute = true });
        _webview.Visible = !HasWebView2();

        _bar.SetBounds(32, 312, 496, 8);
        _status.SetBounds(32, 324, 330, 40);
        _status.ForeColor = Muted;
        Style(_install, true);
        _install.SetBounds(398, 326, 130, 38);
        _install.Click += async (_, _) => await InstallAsync();
        AcceptButton = _install;

        var existing = InstalledVersion();
        if (existing is not null)
        {
            _install.Text = "Update";
            _status.Text = $"Version {existing} is installed. Updating keeps your sign-ins and settings.";
            if (Registry.CurrentUser.OpenSubKey(AppKey)?.GetValue("InstallLocation") is string loc) _path.Text = loc;
        }

        Controls.AddRange(new Control[] { logo, title, sub, where, _path, _browse, _desktop, _launch, _webview, _bar, _status, _install });

        // Update mode only makes sense when there's an install to update.
        _auto = autoUpdate && existing is not null;
        if (_auto)
        {
            Text = "Updating RoLauncher";
            _desktop.Checked = File.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), ShortcutName));
            _launch.Checked = true;
            _status.Text = "Waiting for RoLauncher to close…";
            Shown += async (_, _) =>
            {
                if (_waitPid > 0)
                {
                    try { using var p = Process.GetProcessById(_waitPid); await Task.Run(() => p.WaitForExit(30000)); } catch { /* already closed */ }
                }
                await InstallAsync();
            };
        }
    }

    private static void Style(Button b, bool primary)
    {
        b.FlatStyle = FlatStyle.Flat;
        b.FlatAppearance.BorderSize = 0;
        b.BackColor = primary ? Accent : Color.FromArgb(42, 43, 51);
        b.ForeColor = Color.White;
        b.Font = new Font("Segoe UI Semibold", primary ? 10.5f : 9.5f);
        b.Cursor = Cursors.Hand;
    }

    private static bool HasWebView2()
    {
        foreach (var (hive, path) in new[]
                 {
                     (Registry.LocalMachine, @"SOFTWARE\WOW6432Node\" + WebView2Key),
                     (Registry.LocalMachine, @"SOFTWARE\" + WebView2Key),
                     (Registry.CurrentUser, @"Software\" + WebView2Key),
                 })
        {
            using var k = hive.OpenSubKey(path);
            if (k?.GetValue("pv") is string pv && pv.Length > 0 && pv != "0.0.0.0") return true;
        }
        return false;
    }

    private static string? InstalledVersion()
    {
        using var k = Registry.CurrentUser.OpenSubKey(AppKey);
        return k?.GetValue("DisplayVersion") as string;
    }

    private async Task InstallAsync()
    {
        var dir = Path.GetFullPath(_path.Text.Trim());
        var exe = Path.Combine(dir, ExeName);

        // Never wipe a folder that isn't an earlier RoLauncher install.
        if (Directory.Exists(dir) && Directory.EnumerateFileSystemEntries(dir).Any() && !File.Exists(exe))
        {
            MessageBox.Show(this, "That folder already has other files in it. Pick an empty folder or a new one.", "Install RoLauncher",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        // A running copy keeps its files locked.
        var running = Process.GetProcessesByName("RoLauncher")
            .Where(p => { try { return string.Equals(p.MainModule?.FileName, exe, StringComparison.OrdinalIgnoreCase); } catch { return false; } })
            .ToList();
        if (running.Count > 0)
        {
            if (!_auto && MessageBox.Show(this, "RoLauncher is open. Close it and continue?", "Install RoLauncher",
                    MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
            foreach (var p in running) { try { p.CloseMainWindow(); if (!p.WaitForExit(5000)) p.Kill(true); } catch { } }
        }

        _install.Enabled = _browse.Enabled = _path.Enabled = false;
        _bar.Visible = true;
        try
        {
            var progress = new Progress<(int done, int total)>(p =>
            {
                _bar.Maximum = Math.Max(1, p.total);
                _bar.Value = Math.Min(p.done, _bar.Maximum);
                _status.Text = $"Copying files… {p.done}/{p.total}";
            });
            await Task.Run(() => Extract(dir, progress));

            _status.Text = "Creating shortcuts…";
            CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), ShortcutName), exe);
            var desktopLnk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), ShortcutName);
            if (_desktop.Checked) CreateShortcut(desktopLnk, exe);
            else if (File.Exists(desktopLnk)) File.Delete(desktopLnk);

            Register(dir, exe);
            _status.Text = "Done! RoLauncher is installed.";
            _bar.Value = _bar.Maximum;

            if (_launch.Checked) Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true, WorkingDirectory = dir });
            if (_auto) { Close(); return; }
            MessageBox.Show(this, "RoLauncher is installed. You'll find it in the Start menu" + (_desktop.Checked ? " and on your desktop." : "."),
                "Install RoLauncher", MessageBoxButtons.OK, MessageBoxIcon.Information);
            Close();
        }
        catch (Exception ex)
        {
            _status.Text = "Install failed.";
            MessageBox.Show(this, "Couldn't install RoLauncher:\n\n" + ex.Message, "Install RoLauncher", MessageBoxButtons.OK, MessageBoxIcon.Error);
            _install.Enabled = _browse.Enabled = _path.Enabled = true;
        }
    }

    private static void Extract(string dir, IProgress<(int, int)> progress)
    {
        using var payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")
                            ?? throw new InvalidOperationException("This installer is missing its files. Rebuild it with build-installer.ps1.");
        using var zip = new ZipArchive(payload, ZipArchiveMode.Read);

        // Clean out the previous version first (only reached for empty folders or earlier installs).
        if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        Directory.CreateDirectory(dir);
        var root = Path.GetFullPath(dir) + Path.DirectorySeparatorChar;

        var files = zip.Entries.Where(e => !string.IsNullOrEmpty(e.Name)).ToList();
        var done = 0;
        foreach (var entry in files)
        {
            var target = Path.GetFullPath(Path.Combine(dir, entry.FullName));
            if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue; // guard against odd paths
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            entry.ExtractToFile(target, overwrite: true);
            progress.Report((++done, files.Count));
        }
    }

    private static void CreateShortcut(string lnkPath, string target)
    {
        var shellType = Type.GetTypeFromProgID("WScript.Shell") ?? throw new InvalidOperationException("Windows Script Host is unavailable");
        dynamic shell = Activator.CreateInstance(shellType)!;
        try
        {
            dynamic lnk = shell.CreateShortcut(lnkPath);
            lnk.TargetPath = target;
            lnk.WorkingDirectory = Path.GetDirectoryName(target);
            lnk.IconLocation = target + ",0";
            lnk.Description = "RoLauncher";
            lnk.Save();
        }
        finally { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell); }
    }

    private static void Register(string dir, string exe)
    {
        var version = FileVersionInfo.GetVersionInfo(exe).ProductVersion?.Split('+')[0] ?? "1.0.0";
        long sizeKb = Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories).Sum(f => new FileInfo(f).Length) / 1024;
        using var k = Registry.CurrentUser.CreateSubKey(AppKey);
        k.SetValue("DisplayName", "RoLauncher");
        k.SetValue("DisplayVersion", version);
        k.SetValue("Publisher", "RoLauncher");
        k.SetValue("DisplayIcon", exe + ",0");
        k.SetValue("InstallLocation", dir);
        k.SetValue("UninstallString", $"\"{exe}\" --uninstall");
        k.SetValue("QuietUninstallString", $"\"{exe}\" --uninstall --quiet");
        k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
        k.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, sizeKb), RegistryValueKind.DWord);
        k.SetValue("NoModify", 1, RegistryValueKind.DWord);
        k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
    }
}
