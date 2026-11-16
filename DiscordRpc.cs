using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace RoLauncher;

/// <summary>
/// Minimal Discord Rich Presence client over Discord's local IPC pipe (\\.\pipe\discord-ipc-N).
/// Frames are: int32 opcode, int32 length (little-endian), UTF-8 JSON.
/// A background loop keeps the connection alive, reconnects when Discord restarts,
/// and always sends the latest activity. Nothing leaves the PC except to the local Discord app.
/// </summary>
public sealed class DiscordRpc : IDisposable
{
    private const int OpHandshake = 0, OpFrame = 1, OpClose = 2, OpPing = 3, OpPong = 4;

    private readonly object _lock = new();
    private readonly AutoResetEvent _wake = new(false);
    private readonly CancellationTokenSource _cts = new();
    private string? _clientId;
    private bool _enabled;
    private JsonObject? _activity;
    private bool _dirty;
    private string _status = "off";

    /// <summary>Raised (on a worker thread) when the connection state changes: off, connecting, connected, error.</summary>
    public event Action<string, string?>? StatusChanged;

    public DiscordRpc() => _ = Task.Run(LoopAsync);

    public void Configure(bool enabled, string? clientId)
    {
        clientId = clientId?.Trim();
        if (clientId is not null && (clientId.Length is < 15 or > 25 || !clientId.All(char.IsAsciiDigit))) clientId = null;
        lock (_lock)
        {
            if (_enabled == enabled && _clientId == clientId) return;
            _enabled = enabled;
            _clientId = clientId;
            _dirty = true;
        }
        _wake.Set();
    }

    public void SetActivity(JsonObject? activity)
    {
        lock (_lock) { _activity = activity; _dirty = true; }
        _wake.Set();
    }

    public string Status => _status;

    private void SetStatus(string status, string? detail = null)
    {
        if (_status == status && detail is null) return;
        _status = status;
        try { StatusChanged?.Invoke(status, detail); } catch { /* UI closed */ }
    }

    private async Task LoopAsync()
    {
        NamedPipeClientStream? pipe = null;
        string? connectedId = null;
        var ct = _cts.Token;

        while (!ct.IsCancellationRequested)
        {
            bool enabled; string? id; JsonObject? activity; bool dirty;
            lock (_lock) { enabled = _enabled; id = _clientId; activity = _activity?.DeepClone() as JsonObject; dirty = _dirty; _dirty = false; }

            try
            {
                if (!enabled || id is null)
                {
                    if (pipe is not null) { await TryClearAsync(pipe); pipe.Dispose(); pipe = null; connectedId = null; }
                    SetStatus(enabled ? "error" : "off", enabled ? "Add your Discord Application ID in Settings." : null);
                    _wake.WaitOne(TimeSpan.FromSeconds(30));
                    continue;
                }

                if (pipe is null || !pipe.IsConnected || connectedId != id)
                {
                    pipe?.Dispose();
                    pipe = null;
                    SetStatus("connecting");
                    pipe = await ConnectAsync(id, ct);
                    if (pipe is null)
                    {
                        SetStatus("error", "Discord isn't running (or isn't the desktop app).");
                        _wake.WaitOne(TimeSpan.FromSeconds(15));
                        lock (_lock) _dirty = true;
                        continue;
                    }
                    connectedId = id;
                    dirty = true;
                    SetStatus("connected");
                }

                if (dirty)
                {
                    var payload = new JsonObject
                    {
                        ["cmd"] = "SET_ACTIVITY",
                        ["args"] = new JsonObject { ["pid"] = Environment.ProcessId, ["activity"] = activity },
                        ["nonce"] = Guid.NewGuid().ToString()
                    };
                    await WriteAsync(pipe, OpFrame, payload, ct);
                    var (op, reply) = await ReadAsync(pipe, ct);
                    if (op == OpClose) throw new IOException(reply?["message"]?.GetValue<string>() ?? "Discord closed the connection");
                    if (reply?["evt"]?.GetValue<string>() == "ERROR")
                        SetStatus("error", reply["data"]?["message"]?.GetValue<string>() ?? "Discord rejected the status");
                    else if (_status != "connected") SetStatus("connected");
                }

                // Idle: wait for a change; every 20 s make sure the pipe is still alive.
                if (!_wake.WaitOne(TimeSpan.FromSeconds(20)) && pipe.IsConnected)
                {
                    await WriteAsync(pipe, OpPing, new JsonObject { ["nonce"] = Guid.NewGuid().ToString() }, ct);
                    var (op, _) = await ReadAsync(pipe, ct);
                    if (op == OpClose) throw new IOException("Discord closed the connection");
                }
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                pipe?.Dispose();
                pipe = null;
                connectedId = null;
                SetStatus("error", ex.Message);
                lock (_lock) _dirty = true;
                _wake.WaitOne(TimeSpan.FromSeconds(10));
            }
        }
        if (pipe is not null) { await TryClearAsync(pipe); pipe.Dispose(); }
    }

    private static async Task<NamedPipeClientStream?> ConnectAsync(string clientId, CancellationToken ct)
    {
        for (var i = 0; i < 10; i++)
        {
            var pipe = new NamedPipeClientStream(".", $"discord-ipc-{i}", PipeDirection.InOut, PipeOptions.Asynchronous);
            try
            {
                await pipe.ConnectAsync(400, ct);
                await WriteAsync(pipe, OpHandshake, new JsonObject { ["v"] = 1, ["client_id"] = clientId }, ct);
                var (op, reply) = await ReadAsync(pipe, ct);
                if (op == OpFrame && reply?["evt"]?.GetValue<string>() == "READY") return pipe;
                pipe.Dispose();
                if (op == OpClose)
                    throw new IOException(reply?["message"]?.GetValue<string>() is { } m ? $"Discord: {m}" : "Discord refused the Application ID");
            }
            catch (TimeoutException) { pipe.Dispose(); }
            catch (IOException) when (!pipe.IsConnected) { pipe.Dispose(); }
        }
        return null;
    }

    private static async Task TryClearAsync(NamedPipeClientStream pipe)
    {
        try
        {
            using var cts = new CancellationTokenSource(1000);
            await WriteAsync(pipe, OpFrame, new JsonObject
            {
                ["cmd"] = "SET_ACTIVITY",
                ["args"] = new JsonObject { ["pid"] = Environment.ProcessId, ["activity"] = null },
                ["nonce"] = Guid.NewGuid().ToString()
            }, cts.Token);
        }
        catch { /* best effort */ }
    }

    private static async Task WriteAsync(Stream s, int op, JsonNode payload, CancellationToken ct)
    {
        var body = Encoding.UTF8.GetBytes(payload.ToJsonString());
        var frame = new byte[8 + body.Length];
        BitConverter.TryWriteBytes(frame.AsSpan(0, 4), op);
        BitConverter.TryWriteBytes(frame.AsSpan(4, 4), body.Length);
        body.CopyTo(frame, 8);
        await s.WriteAsync(frame, ct);
        await s.FlushAsync(ct);
    }

    private static async Task<(int op, JsonNode? body)> ReadAsync(Stream s, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        var header = new byte[8];
        await s.ReadExactlyAsync(header, timeout.Token);
        var op = BitConverter.ToInt32(header, 0);
        var len = BitConverter.ToInt32(header, 4);
        if (len is < 0 or > 1_000_000) throw new IOException("Bad frame from Discord");
        var body = new byte[len];
        await s.ReadExactlyAsync(body, timeout.Token);
        JsonNode? node = null;
        try { node = JsonNode.Parse(body); } catch (JsonException) { }
        return (op, node);
    }

    public void Dispose()
    {
        lock (_lock) { _enabled = false; _dirty = true; }
        _wake.Set();
        _cts.CancelAfter(1500);
    }
}
