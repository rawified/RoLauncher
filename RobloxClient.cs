using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;

namespace RoLauncher;

/// <summary>
/// HTTP client for *.roblox.com. When the user has signed in (through the embedded
/// roblox.com login page) the session cookie is attached to requests and the
/// X-CSRF-TOKEN handshake is handled automatically. The cookie itself lives only in
/// the WebView2 profile; it is read from there and kept in memory.
/// </summary>
public sealed class RobloxClient
{
    private readonly HttpClient _http;
    private string? _cookie;
    private string? _csrf;

    public RobloxClient()
    {
        _http = new HttpClient(new HttpClientHandler { UseCookies = false, AutomaticDecompression = DecompressionMethods.All })
        {
            Timeout = TimeSpan.FromSeconds(20)
        };
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("RoLauncher", "1.1"));
    }

    public bool IsSignedIn => _cookie is not null;

    public void SetCookie(string? value)
    {
        _cookie = string.IsNullOrEmpty(value) ? null : value;
        _csrf = null;
    }

    public static bool IsRobloxHost(Uri uri) =>
        uri.Scheme == "https" && (uri.Host == "roblox.com" || uri.Host.EndsWith(".roblox.com", StringComparison.OrdinalIgnoreCase));

    public async Task<HttpResponseMessage> SendAsync(HttpMethod method, string url, JsonNode? body = null)
    {
        var uri = new Uri(url);
        if (!IsRobloxHost(uri)) throw new InvalidOperationException("Only https://*.roblox.com requests are allowed");

        for (var attempt = 0; ; attempt++)
        {
            using var req = new HttpRequestMessage(method, uri);
            if (_cookie is not null) req.Headers.Add("Cookie", ".ROBLOSECURITY=" + _cookie);
            if (method != HttpMethod.Get)
            {
                req.Content = new StringContent(body?.ToJsonString() ?? "{}", Encoding.UTF8, "application/json");
                if (_csrf is not null) req.Headers.Add("X-CSRF-TOKEN", _csrf);
                req.Headers.Referrer = new Uri("https://www.roblox.com/");
                req.Headers.Add("Origin", "https://www.roblox.com");
            }

            var res = await _http.SendAsync(req);
            if (res.StatusCode == HttpStatusCode.Forbidden && attempt == 0 &&
                res.Headers.TryGetValues("x-csrf-token", out var tokens))
            {
                _csrf = tokens.FirstOrDefault();
                res.Dispose();
                continue; // retry once with the fresh token
            }
            return res;
        }
    }

    public async Task<JsonNode?> GetJsonAsync(HttpMethod method, string url, JsonNode? body = null)
    {
        using var res = await SendAsync(method, url, body);
        var text = await res.Content.ReadAsStringAsync();
        if (!res.IsSuccessStatusCode)
        {
            string? detail = null;
            try
            {
                var j = JsonNode.Parse(text);
                detail = j?["errors"]?[0]?["message"]?.GetValue<string>()
                         ?? j?["errorMessage"]?.GetValue<string>()
                         ?? j?["message"]?.GetValue<string>();
            }
            catch { /* not JSON */ }
            throw new HttpRequestException(string.IsNullOrWhiteSpace(detail)
                ? $"HTTP {(int)res.StatusCode} from {new Uri(url).Host}"
                : detail);
        }
        return string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);
    }

    /// <summary>Returns {id,name,displayName} of the signed-in user, or null if the cookie is invalid.</summary>
    public async Task<JsonNode?> GetAuthenticatedUserAsync()
    {
        if (_cookie is null) return null;
        using var res = await SendAsync(HttpMethod.Get, "https://users.roblox.com/v1/users/authenticated");
        if (!res.IsSuccessStatusCode) return null;
        return JsonNode.Parse(await res.Content.ReadAsStringAsync());
    }

    /// <summary>One-time ticket that lets the Roblox player sign in as this account.</summary>
    public async Task<string> GetAuthTicketAsync()
    {
        using var res = await SendAsync(HttpMethod.Post, "https://auth.roblox.com/v1/authentication-ticket/");
        if (res.Headers.TryGetValues("rbx-authentication-ticket", out var t) && t.FirstOrDefault() is { Length: > 0 } ticket)
            return ticket;
        throw new InvalidOperationException($"Couldn't get a launch ticket (HTTP {(int)res.StatusCode}). Try signing in again.");
    }

    public async Task LogoutAsync()
    {
        if (_cookie is null) return;
        try { using var _ = await SendAsync(HttpMethod.Post, "https://auth.roblox.com/v2/logout"); } catch { /* best effort */ }
        SetCookie(null);
    }
}
