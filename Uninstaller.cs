using System.Diagnostics;
using Microsoft.Win32;

namespace RoLauncher;

/// <summary>
/// "RoLauncher.exe --uninstall", called from Windows' Installed apps list.
/// Removes what the installer (installer/Setup) created. It only ever deletes the folder
/// recorded as the install location, and only when this copy is running from it.
/// </summary>
internal static class Uninstaller
{
    public const string AppKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\RoLauncher";
    public const string ShortcutName = "RoLauncher.lnk";

    public static void Run(bool quiet)
    {
        using var key = Registry.CurrentUser.OpenSubKey(AppKey);
        var installDir = key?.GetValue("InstallLocation") as string;
        var here = Path.GetFullPath(AppContext.BaseDirectory).TrimEnd('\\');
        if (string.IsNullOrEmpty(installDir) || !string.Equals(Path.GetFullPath(installDir).TrimEnd('\\'), here, StringComparison.OrdinalIgnoreCase))
        {
            if (!quiet) MessageBox.Show("This copy of RoLauncher wasn't installed with the installer, so there's nothing to uninstall here.",
                "RoLauncher", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        if (!quiet && MessageBox.Show("Uninstall RoLauncher from this PC?", "Uninstall RoLauncher",
                MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;

        // Other running copies keep files locked.
        var others = Process.GetProcessesByName("RoLauncher")
            .Where(p =>
            {
                if (p.Id == Environment.ProcessId) return false;
                try { return p.MainModule?.FileName is string f && f.StartsWith(here + "\\", StringComparison.OrdinalIgnoreCase); }
                catch { return false; }
            })
            .ToList();
        if (others.Count > 0)
        {
            if (!quiet && MessageBox.Show("RoLauncher is still open. Close it and continue?", "Uninstall RoLauncher",
                    MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK) return;
            foreach (var p in others)
            {
                try { p.CloseMainWindow(); if (!p.WaitForExit(4000)) p.Kill(true); } catch { /* gone */ }
            }
        }

        var deleteData = !quiet && MessageBox.Show(
            "Also delete your RoLauncher data?\n\nThis removes saved Roblox sign-ins, favorites, playtime and settings. Choose No to keep them for a later reinstall.",
            "Uninstall RoLauncher", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) == DialogResult.Yes;

        foreach (var dir in new[] { Environment.SpecialFolder.Programs, Environment.SpecialFolder.DesktopDirectory })
        {
            try { File.Delete(Path.Combine(Environment.GetFolderPath(dir), ShortcutName)); } catch { /* not there */ }
        }
        try { Registry.CurrentUser.DeleteSubKeyTree(AppKey, throwOnMissingSubKey: false); } catch { /* best effort */ }

        if (deleteData)
        {
            var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RoLauncher");
            try { if (Directory.Exists(data)) Directory.Delete(data, recursive: true); } catch { /* in use: left behind */ }
        }

        // This exe lives in the folder being removed, so let a hidden cmd delete it after we exit.
        Process.Start(new ProcessStartInfo("cmd.exe", $"/c ping 127.0.0.1 -n 3 > nul & rmdir /s /q \"{here}\"")
        {
            CreateNoWindow = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetTempPath(), // cmd sitting in the folder would stop it being removed

            WindowStyle = ProcessWindowStyle.Hidden
        });

        if (!quiet) MessageBox.Show("RoLauncher has been uninstalled.", "RoLauncher", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }
}
