namespace RoLauncher;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();

        // Shortcuts start us inside the install folder, and every program we start (Roblox, the
        // updater, the uninstaller's clean-up) inherits that as its working folder, which keeps the
        // folder locked. Work from the data folder instead so updates can replace the install.
        try
        {
            var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RoLauncher");
            Directory.CreateDirectory(data);
            Environment.CurrentDirectory = data;
        }
        catch { /* keep the inherited folder */ }

        if (args.Contains("--uninstall", StringComparer.OrdinalIgnoreCase))
        {
            Uninstaller.Run(quiet: args.Contains("--quiet", StringComparer.OrdinalIgnoreCase));
            return;
        }

        Application.Run(new MainForm());
    }
}
