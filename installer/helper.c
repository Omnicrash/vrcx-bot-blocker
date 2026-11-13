// botblocker-helper.exe - the installer's hands, so the wizard never touches custom.js through
// NSIS's own text functions, which would round-trip other people's UTF-8 through the ANSI code
// page. Everything here works on raw bytes.
//
//   botblocker-helper install <custom.js> <bot-blocker.js> [share=0|1]
//                                                           add or replace our block; share is the
//                                                           installer's shared-blocklist checkbox
//   botblocker-helper uninstall <custom.js>                  take our block out again
//   botblocker-helper running                                exit 0 when VRCX runs, 1 when not
//   botblocker-helper restart                                close VRCX and start it again
//
// Our block sits between two marker lines; anything else in custom.js stays exactly as it was.
// The markers match what the earlier PowerShell installer wrote, so this replaces those copies.
#include <windows.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

static const char START[] = "// ==== vrcx-bot-blocker start (added by the VRCX Bot Blocker installer - uninstall it instead of editing here) ====";
static const char START_PREFIX[] = "// ==== vrcx-bot-blocker start";
static const char END[] = "// ==== vrcx-bot-blocker end ====";

typedef struct {
    char *data;
    size_t len;
} Buf;

static int read_file(const wchar_t *path, Buf *out)
{
    out->data = NULL;
    out->len = 0;
    FILE *f = _wfopen(path, L"rb");
    if (!f) {
        return 0;
    }
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    out->data = malloc(n + 1);
    out->len = fread(out->data, 1, n, f);
    out->data[out->len] = 0;
    fclose(f);
    return 1;
}

static int write_file(const wchar_t *path, const char *data, size_t len)
{
    // Write next to it, then swap, so a failure never leaves half a custom.js behind.
    wchar_t tmp[MAX_PATH + 8];
    swprintf(tmp, MAX_PATH + 8, L"%ls.tmp", path);
    FILE *f = _wfopen(tmp, L"wb");
    if (!f) {
        return 0;
    }
    int ok = fwrite(data, 1, len, f) == len;
    ok = fclose(f) == 0 && ok;
    return ok && MoveFileExW(tmp, path, MOVEFILE_REPLACE_EXISTING);
}

// Cuts our block (start marker line through end marker line) out of buf in place.
static void remove_block(Buf *buf)
{
    char *start = strstr(buf->data, START_PREFIX);
    if (!start) {
        return;
    }
    char *end = strstr(start, END);
    if (!end) {
        return;
    }
    end += strlen(END);
    while (*end == '\r' || *end == '\n') {
        end++;
    }
    while (start > buf->data && (start[-1] == '\r' || start[-1] == '\n')) {
        start--;
    }
    memmove(start, end, buf->len - (end - buf->data) + 1);
    buf->len -= end - start;
}

static int only_whitespace(const Buf *buf)
{
    for (size_t i = 0; i < buf->len; i++) {
        if (!strchr(" \t\r\n", buf->data[i])) {
            return 0;
        }
    }
    return 1;
}

static int backup(const wchar_t *path)
{
    wchar_t bak[MAX_PATH + 8];
    swprintf(bak, MAX_PATH + 8, L"%ls.bak", path);
    return CopyFileW(path, bak, FALSE);
}

// Appends the plugin to out, rewriting the two lines the installer owns: the shared-blocklist
// choice and the install stamp the plugin uses to notice a fresh install.
static size_t put_plugin(char *out, const Buf *js, int share, unsigned long long stamp)
{
    size_t n = 0;
    const char *p = js->data, *end = js->data + js->len;
    while (p < end) {
        const char *nl = memchr(p, '\n', end - p);
        const char *stop = nl ? nl : end;
        char line[256];
        size_t len = stop - p;
        if (len < sizeof line && (memcpy(line, p, len), line[len] = 0, strstr(line, "@SHARE_DEFAULT@"))) {
            n += sprintf(out + n, "    const SHARE_DEFAULT = %s; // @SHARE_DEFAULT@", share ? "true" : "false");
        } else if (len < sizeof line && strstr(line, "@INSTALL_STAMP@")) {
            n += sprintf(out + n, "    const INSTALL_STAMP = '%llu'; // @INSTALL_STAMP@", stamp);
        } else {
            memcpy(out + n, p, len);
            n += len;
        }
        if (nl) {
            out[n++] = '\n';
        }
        p = nl ? nl + 1 : end;
    }
    return n;
}

static int install(const wchar_t *target, const wchar_t *plugin, int share)
{
    Buf js, cur;
    if (!read_file(plugin, &js)) {
        fwprintf(stderr, L"cannot read %ls\n", plugin);
        return 2;
    }
    if (read_file(target, &cur)) {
        backup(target);
        remove_block(&cur);
    } else {
        cur.data = calloc(1, 1);
        cur.len = 0;
    }
    while (js.len && strchr(" \t\r\n", js.data[js.len - 1])) {
        js.len--;
    }

    size_t cap = cur.len + js.len + sizeof START + sizeof END + 256;
    char *out = malloc(cap);
    size_t n = 0;
    if (!only_whitespace(&cur)) {
        size_t keep = cur.len;
        while (keep && strchr(" \t\r\n", cur.data[keep - 1])) {
            keep--;
        }
        memcpy(out, cur.data, keep);
        n = keep;
        memcpy(out + n, "\r\n\r\n", 4);
        n += 4;
    }
    n += sprintf(out + n, "%s\r\n", START);
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    unsigned long long stamp = (((unsigned long long)ft.dwHighDateTime << 32) | ft.dwLowDateTime) / 10000;
    n += put_plugin(out + n, &js, share, stamp);
    n += sprintf(out + n, "\r\n%s\r\n", END);

    if (!write_file(target, out, n)) {
        fwprintf(stderr, L"cannot write %ls\n", target);
        return 3;
    }
    return 0;
}

static int uninstall(const wchar_t *target)
{
    Buf cur;
    if (!read_file(target, &cur) || !strstr(cur.data, START_PREFIX)) {
        return 0;
    }
    backup(target);
    remove_block(&cur);
    if (only_whitespace(&cur)) {
        return DeleteFileW(target) ? 0 : 3;
    }
    return write_file(target, cur.data, cur.len) ? 0 : 3;
}

// Calls fn for every running VRCX.exe; returns how many there were.
static int each_vrcx(void (*fn)(DWORD pid, void *ctx), void *ctx)
{
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    PROCESSENTRY32W pe = { .dwSize = sizeof pe };
    int count = 0;
    for (BOOL more = Process32FirstW(snap, &pe); more; more = Process32NextW(snap, &pe)) {
        if (_wcsicmp(pe.szExeFile, L"VRCX.exe") == 0) {
            count++;
            if (fn) {
                fn(pe.th32ProcessID, ctx);
            }
        }
    }
    CloseHandle(snap);
    return count;
}

static void grab_path(DWORD pid, void *ctx)
{
    wchar_t *path = ctx;
    if (path[0]) {
        return;
    }
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (h) {
        DWORD size = MAX_PATH;
        QueryFullProcessImageNameW(h, 0, path, &size);
        CloseHandle(h);
    }
}

static void stop(DWORD pid, void *ctx)
{
    (void)ctx;
    HANDLE h = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, FALSE, pid);
    if (h) {
        TerminateProcess(h, 0);
        WaitForSingleObject(h, 5000);
        CloseHandle(h);
    }
}

static int restart(void)
{
    wchar_t path[MAX_PATH] = L"";
    if (!each_vrcx(grab_path, path) || !path[0]) {
        return 1;
    }
    each_vrcx(stop, NULL);
    Sleep(1500);

    // Started from its own folder, as its shortcut would.
    wchar_t dir[MAX_PATH];
    wcscpy(dir, path);
    wchar_t *slash = wcsrchr(dir, L'\\');
    if (slash) {
        *slash = 0;
    }
    return (INT_PTR)ShellExecuteW(NULL, L"open", path, NULL, dir, SW_SHOWNORMAL) > 32 ? 0 : 4;
}

int wmain(int argc, wchar_t **argv)
{
    if ((argc == 4 || argc == 5) && !wcscmp(argv[1], L"install")) {
        return install(argv[2], argv[3], argc == 4 || wcscmp(argv[4], L"share=0") != 0);
    }
    if (argc == 3 && !wcscmp(argv[1], L"uninstall")) {
        return uninstall(argv[2]);
    }
    if (argc == 2 && !wcscmp(argv[1], L"running")) {
        return each_vrcx(NULL, NULL) ? 0 : 1;
    }
    if (argc == 2 && !wcscmp(argv[1], L"restart")) {
        return restart();
    }
    fwprintf(stderr, L"usage: botblocker-helper install <custom.js> <plugin.js> | uninstall <custom.js> | running | restart\n");
    return 64;
}
