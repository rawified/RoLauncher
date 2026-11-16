using System.Diagnostics;
using System.Net.Http.Headers;
using System.Reflection;
using System.Text.Json.Nodes;

namespace RoLauncher;

/// <summary>
/// Updates from the project's GitHub Releases. A release is tagged like "v1.2.3" and has
/// RoLauncherSetup-1.2.3.exe attached (build-installer.ps1 makes it). Installing runs that
/// setup with "--update": it waits for the launcher to close, updates the installed copy
/// in place (sign-ins and settings stay), then opens it again.
/// </summary>
internal static class Updater
{
    public const string Owner = "rawified";
    public const string Repo = "RoLauncher";
    public static string RepoUrl => $"https://github.com/{Owner}/{Repo}";

    private static readonly HttpClient Http = CreateClient();

    private static HttpClient CreateClient()
    {
        var h = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        h.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("RoLauncher", CurrentVersion.ToString(3)));
        h.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        return h;
    }

    public static Version CurrentVersion => Assembly.GetExecutingAssembly().GetName().Version ?? new Version(1, 0, 0);

    public static bool IsInstalledCopy()
    {
        using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(Uninstaller.AppKey);
        return key?.GetValue("InstallLocation") is string dir &&
               string.Equals(Path.GetFullPath(dir).TrimEnd('\\'), Path.GetFullPath(AppContext.BaseDirectory).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
    }

    public static object Info() => new
    {
        version = CurrentVersion.ToString(3),
        repo = RepoUrl,
        installed = IsInstalledCopy(),
    };

    /// <summary>Latest release on GitHub, and whether it's newer than this copy.</summary>
    public static async Task<object> CheckAsync()
    {
        using var res = await Http.GetAsync($"https://api.github.com/repos/{Owner}/{Repo}/releases/latest");
        if (res.StatusCode == System.Net.HttpStatusCode.NotFound)
            return new { available = false, current = CurrentVersion.ToString(3), latest = (string?)null };
        if (!res.IsSuccessStatusCode) throw new InvalidOperationException($"GitHub answered {(int)res.StatusCode}");
        var json = JsonNode.Parse(await res.Content.ReadAsStringAsync())!;

        var tag = json["tag_name"]?.GetValue<string>() ?? "";
        if (!Version.TryParse(tag.TrimStart('v', 'V'), out var latest)) throw new InvalidOperationException($"Can't read release version '{tag}'");
        var asset = (json["assets"] as JsonArray ?? new JsonArray())
            .Select(a => new { name = a?["name"]?.GetValue<string>() ?? "", url = a?["browser_download_url"]?.GetValue<string>() ?? "", size = a?["size"]?.GetValue<long>() ?? 0 })
            .FirstOrDefault(a => a.name.StartsWith("RoLauncherSetup", StringComparison.OrdinalIgnoreCase) && a.name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase));

        return new
        {
            available = Normalize(latest) > Normalize(CurrentVersion) && asset is not null,
            current = CurrentVersion.ToString(3),
            latest = Normalize(latest).ToString(3),
            name = json["name"]?.GetValue<string>(),
            notes = json["body"]?.GetValue<string>() ?? "",
            page = json["html_url"]?.GetValue<string>(),
            published = json["published_at"]?.GetValue<string>(),
            download = asset?.url,
            size = asset?.size ?? 0,
        };
    }

    /// <summary>Downloads the setup from this repo's releases (nowhere else) and starts it in update mode.</summary>
    public static async Task InstallAsync(string url, Action<double> progress)
    {
        if (!url.StartsWith($"https://github.com/{Owner}/{Repo}/releases/download/", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Updates only come from this project's GitHub releases.");

        var file = Path.Combine(Path.GetTempPath(), "RoLauncher-update", Path.GetFileName(new Uri(url).LocalPath));
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);

        using (var res = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead))
        {
            res.EnsureSuccessStatusCode();
            var total = res.Content.Headers.ContentLength ?? 0;
            await using var src = await res.Content.ReadAsStreamAsync();
            await using var dst = File.Create(file);
            var buf = new byte[81920];
            long done = 0; int n; var last = DateTime.MinValue;
            while ((n = await src.ReadAsync(buf)) > 0)
            {
                await dst.WriteAsync(buf.AsMemory(0, n));
                done += n;
                if (total > 0 && (DateTime.UtcNow - last).TotalMilliseconds > 120) { last = DateTime.UtcNow; progress((double)done / total); }
            }
        }
        progress(1);

        Process.Start(new ProcessStartInfo(file, $"--update --wait {Environment.ProcessId}") { UseShellExecute = true });
    }

    private static Version Normalize(Version v) => new(v.Major, Math.Max(0, v.Minor), Math.Max(0, v.Build));
}
