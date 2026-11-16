namespace RoLauncher;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();

        if (args.Contains("--uninstall", StringComparer.OrdinalIgnoreCase))
        {
            Uninstaller.Run(quiet: args.Contains("--quiet", StringComparer.OrdinalIgnoreCase));
            return;
        }

        Application.Run(new MainForm());
    }
}
