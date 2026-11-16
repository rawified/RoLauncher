using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RoLauncher;

public sealed class SavedAccount
{
    public long Id { get; set; }
    public string Name { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string Cookie { get; set; } = "";
    public DateTime AddedUtc { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// Signed-in Roblox accounts. Session cookies are encrypted with Windows DPAPI
/// (CurrentUser scope), so the file is useless on another PC or Windows user.
/// Cookies never leave the C# side; the page only sees id / name / display name.
/// </summary>
public sealed class AccountStore
{
    private sealed class FileModel
    {
        public long ActiveId { get; set; }
        public List<SavedAccount> Accounts { get; set; } = new();
    }

    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("RoLauncher.accounts.v1");
    private readonly string _path;
    private FileModel _data = new();

    public AccountStore(string dataDir)
    {
        _path = Path.Combine(dataDir, "accounts.dat");
        Load();
    }

    public IReadOnlyList<SavedAccount> Accounts => _data.Accounts;
    public SavedAccount? Active => _data.Accounts.FirstOrDefault(a => a.Id == _data.ActiveId);
    public SavedAccount? Get(long id) => _data.Accounts.FirstOrDefault(a => a.Id == id);

    public void Upsert(SavedAccount acc, bool makeActive)
    {
        _data.Accounts.RemoveAll(a => a.Id == acc.Id);
        _data.Accounts.Add(acc);
        if (makeActive) _data.ActiveId = acc.Id;
        Save();
    }

    public void SetActive(long id)
    {
        if (Get(id) is null) throw new InvalidOperationException("Unknown account");
        _data.ActiveId = id;
        Save();
    }

    public void Remove(long id)
    {
        _data.Accounts.RemoveAll(a => a.Id == id);
        if (_data.ActiveId == id) _data.ActiveId = _data.Accounts.FirstOrDefault()?.Id ?? 0;
        Save();
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_path)) return;
            var plain = ProtectedData.Unprotect(File.ReadAllBytes(_path), Entropy, DataProtectionScope.CurrentUser);
            _data = JsonSerializer.Deserialize<FileModel>(plain) ?? new FileModel();
        }
        catch
        {
            _data = new FileModel(); // unreadable (other user / corrupted): start fresh
        }
    }

    private void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var plain = JsonSerializer.SerializeToUtf8Bytes(_data);
        var tmp = _path + ".tmp";
        File.WriteAllBytes(tmp, ProtectedData.Protect(plain, Entropy, DataProtectionScope.CurrentUser));
        File.Move(tmp, _path, overwrite: true);
    }
}
