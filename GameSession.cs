using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace RoLauncher;

public sealed record LaunchOptions(bool Embed, bool CloseOnLeave, bool MinimizeLauncher);

/// <summary>
/// Follows one Roblox play session: finds the RobloxPlayerBeta process that the launch
/// started, tails its log file to see when a server is joined / left, and reports
/// everything through <see cref="Changed"/> (raised on a worker thread).
/// </summary>
public sealed partial class GameSession : IDisposable
{
    public event Action<string, Dictionary<string, object?>>? Changed;

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<int, byte> ClaimedPids = new();
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, byte> ClaimedLogs = new();
    private readonly DateTime _launchedAt = DateTime.Now;
    private string? _logPath;
    private readonly CancellationTokenSource _cts = new();
    private Process? _process;
    private bool _ended;

    public LaunchOptions Options { get; }
    public IntPtr GameWindow { get; private set; }
    public bool IsRunning => _process is { HasExited: false };

    public GameSession(LaunchOptions options) => Options = options;

    [GeneratedRegex(@"! Joining game '([0-9a-fA-F-]{36})' place (\d+)")]
    private static partial Regex JoinRegex();
    [GeneratedRegex(@"universeid:(\d+)")]
    private static partial Regex UniverseRegex();

    public void Start() => _ = Task.Run(RunAsync);

    private async Task RunAsync()
    {
        var ct = _cts.Token;
        try
        {
            Raise("starting");
            _process = await WaitForProcessAsync(TimeSpan.FromSeconds(90), ct);
            if (_process is null) { Raise("failed", ("error", "Roblox didn't start. Is it installed?")); return; }
            Raise("process", ("pid", _process.Id));

            var windowTask = WaitForWindowAsync(ct);
            var logTask = TailLogAsync(ct);
            var win = await windowTask;
            if (win != IntPtr.Zero) { GameWindow = win; Raise("window"); }

            await Task.WhenAny(logTask, _process.WaitForExitAsync(ct));
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) { Raise("failed", ("error", ex.Message)); }
        finally { End(); }
    }

    private void End()
    {
        if (_ended) return;
        _ended = true;
        Raise("ended");
    }

    /// <summary>Closes the Roblox process for this session.</summary>
    public void Kill()
    {
        try { if (_process is { HasExited: false }) _process.Kill(true); } catch { /* already gone */ }
    }

    public void Dispose()
    {
        _cts.Cancel();
        if (_process is not null) ClaimedPids.TryRemove(_process.Id, out _);
        if (_logPath is not null) ClaimedLogs.TryRemove(_logPath, out _);
        _process?.Dispose();
    }

    // ---------- Process / window discovery ----------

    private async Task<Process?> WaitForProcessAsync(TimeSpan timeout, CancellationToken ct)
    {
        var until = DateTime.Now + timeout;
        while (DateTime.Now < until)
        {
            ct.ThrowIfCancellationRequested();
            var candidates = Process.GetProcessesByName("RobloxPlayerBeta")
                .Select(p => { try { return (p, start: p.StartTime); } catch { return (p, start: DateTime.MinValue); } })
                .Where(x => x.start >= _launchedAt.AddSeconds(-3) && !ClaimedPids.ContainsKey(x.p.Id))
                .OrderBy(x => x.start)
                .ToList();
            foreach (var c in candidates)
                if (ClaimedPids.TryAdd(c.p.Id, 0)) return c.p;
            await Task.Delay(500, ct);
        }
        return null;
    }

    private async Task<IntPtr> WaitForWindowAsync(CancellationToken ct)
    {
        for (var i = 0; i < 240 && _process is { HasExited: false }; i++)
        {
            var h = FindGameWindow(_process.Id);
            if (h != IntPtr.Zero) return h;
            await Task.Delay(250, ct);
        }
        return IntPtr.Zero;
    }

    private static IntPtr FindGameWindow(int pid)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, _) =>
        {
            GetWindowThreadProcessId(h, out var owner);
            if (owner != pid || !IsWindowVisible(h)) return true;
            var cls = new StringBuilder(64);
            GetClassName(h, cls, cls.Capacity);
            if (cls.ToString() == "WINDOWSCLIENT") { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // ---------- Log tailing ----------

    private async Task TailLogAsync(CancellationToken ct)
    {
        var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Roblox", "logs");
        FileInfo? log = null;
        for (var i = 0; i < 120 && log is null; i++)
        {
            ct.ThrowIfCancellationRequested();
            if (Directory.Exists(dir))
            {
                log = new DirectoryInfo(dir).GetFiles("*_Player_*_last.log")
                    .Where(f => !f.Name.Contains("CrashHandler") && f.CreationTime >= _launchedAt.AddSeconds(-5) && !ClaimedLogs.ContainsKey(f.FullName))
                    .OrderBy(f => f.CreationTime)
                    .FirstOrDefault(f => ClaimedLogs.TryAdd(f.FullName, 0));
            }
            if (log is null) await Task.Delay(500, ct);
        }
        if (log is null) { await _process!.WaitForExitAsync(ct); return; }
        _logPath = log.FullName;

        await using var fs = new FileStream(log.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var reader = new StreamReader(fs);
        string? pendingJob = null;

        while (!ct.IsCancellationRequested && _process is { HasExited: false })
        {
            var line = await reader.ReadLineAsync(ct);
            if (line is null) { await Task.Delay(400, ct); continue; }

            if (JoinRegex().Match(line) is { Success: true } jm)
            {
                pendingJob = jm.Groups[1].Value;
                Raise("joining", ("jobId", pendingJob), ("placeId", jm.Groups[2].Value));
            }
            else if (line.Contains("game_join_loadtime") && UniverseRegex().Match(line) is { Success: true } um)
            {
                Raise("joined", ("jobId", pendingJob), ("universeId", um.Groups[1].Value));
            }
            else if (line.Contains("leaveUGCGameInternal"))
            {
                // The player pressed "Leave" in the in-game menu.
                Raise("left");
                if (Options.CloseOnLeave) { Kill(); return; }
            }
        }
    }

    private void Raise(string state, params (string key, object? value)[] data)
    {
        var d = data.ToDictionary(x => x.key, x => x.value);
        try { Changed?.Invoke(state, d); } catch { /* UI closed */ }
    }

    // ---------- Win32 ----------

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int pid);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder s, int max);
}
