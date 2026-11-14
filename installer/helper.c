// botblocker-helper.exe - the installer's hands, so the wizard never touches custom.js through
// NSIS's own text functions, which would round-trip other people's UTF-8 through the ANSI code
// page. Everything here works on raw bytes.
//
//   botblocker-helper install <custom.js> <bot-blocker.js> [share=0|1] [reset=0|1]
//                                                           add or replace our block; share is the
//                                                           installer's shared-blocklist checkbox
//   botblocker-helper uninstall <custom.js>                  take our block out again
//   botblocker-helper running [app.exe]                      exit 0 when VRCX (or app.exe) runs
//   botblocker-helper restart                                close VRCX and start it again
//   botblocker-helper theme <dir> <bot-blocker.js> [share=0|1] [reset=0|1]
//                                                           write the plugin as a VRCNext theme
//   botblocker-helper theme-remove <dir>                     delete that theme again
//   botblocker-helper vrcnext-theme on|off <settings.json>   switch the theme on or off in VRCNext
//   botblocker-helper stop-vrcnext                           close VRCNext the way its X button does;
//                                                           exit 0 when it was running
//   botblocker-helper start <exe>                            start a program from its own folder
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
static size_t put_plugin(char *out, const Buf *js, int share, int reset, unsigned long long stamp)
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
        } else if (len < sizeof line && strstr(line, "@RESET_RULES@")) {
            n += sprintf(out + n, "    const RESET_RULES = %s; // @RESET_RULES@", reset ? "true" : "false");
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

static int install(const wchar_t *target, const wchar_t *plugin, int share, int reset)
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
    n += put_plugin(out + n, &js, share, reset, stamp);
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

// Calls fn for every running process with this exe name; returns how many there were.
static int each_named(const wchar_t *exe, void (*fn)(DWORD pid, void *ctx), void *ctx)
{
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    PROCESSENTRY32W pe = { .dwSize = sizeof pe };
    int count = 0;
    for (BOOL more = Process32FirstW(snap, &pe); more; more = Process32NextW(snap, &pe)) {
        if (_wcsicmp(pe.szExeFile, exe) == 0) {
            count++;
            if (fn) {
                fn(pe.th32ProcessID, ctx);
            }
        }
    }
    CloseHandle(snap);
    return count;
}

static int each_vrcx(void (*fn)(DWORD pid, void *ctx), void *ctx)
{
    return each_named(L"VRCX.exe", fn, ctx);
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

// ---- VRCNext -----------------------------------------------------------------------------------
//
// VRCNext runs the plugin as a theme: a folder in %AppData%\VRCNext\custom-themes, switched on
// in its settings.json (ActiveCustomThemes). VRCNext writes that file when it closes, so it is
// only edited while VRCNext is closed.

static const char THEME_NAME[] = "\"Bot Blocker\"";

static int write_theme(const wchar_t *dir, const wchar_t *plugin, int share, int reset)
{
    Buf js;
    if (!read_file(plugin, &js)) {
        fwprintf(stderr, L"cannot read %ls\n", plugin);
        return 2;
    }
    CreateDirectoryW(dir, NULL);
    char *out = malloc(js.len + 1024);
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    unsigned long long stamp = (((unsigned long long)ft.dwHighDateTime << 32) | ft.dwLowDateTime) / 10000;
    size_t n = put_plugin(out, &js, share, reset, stamp);
    wchar_t path[MAX_PATH];
    swprintf(path, MAX_PATH, L"%ls\\bot-blocker.js", dir);
    if (!write_file(path, out, n)) {
        fwprintf(stderr, L"cannot write %ls\n", path);
        return 3;
    }
    static const char INFO[] = "{\"author\":\"Omnicrash\"}";
    swprintf(path, MAX_PATH, L"%ls\\info.json", dir);
    return write_file(path, INFO, sizeof INFO - 1) ? 0 : 3;
}

static int remove_theme(const wchar_t *dir)
{
    wchar_t path[MAX_PATH];
    swprintf(path, MAX_PATH, L"%ls\\bot-blocker.js", dir);
    DeleteFileW(path);
    swprintf(path, MAX_PATH, L"%ls\\info.json", dir);
    DeleteFileW(path);
    RemoveDirectoryW(dir);
    return 0;
}

// Adds or removes "Bot Blocker" in the ActiveCustomThemes list, leaving the rest byte for byte.
static int switch_theme(int on, const wchar_t *settings)
{
    Buf cur;
    if (!read_file(settings, &cur)) {
        return on ? 2 : 0; // no settings yet: VRCNext never ran, so there's nothing to switch
    }
    char *key = strstr(cur.data, "\"ActiveCustomThemes\"");
    char *open = key ? strchr(key, '[') : NULL;
    char *close = open ? strchr(open, ']') : NULL;
    if (!close) {
        fwprintf(stderr, L"no ActiveCustomThemes list in %ls\n", settings);
        return 4;
    }
    char *ours = strstr(open, THEME_NAME);
    int listed = ours && ours < close;
    if (on == listed) {
        return 0;
    }
    char *out = malloc(cur.len + 64);
    size_t n = 0;
    if (on) {
        const char *p = open + 1;
        while (p < close && strchr(" \t\r\n", *p)) {
            p++;
        }
        n = open + 1 - cur.data;
        memcpy(out, cur.data, n);
        n += sprintf(out + n, p == close ? "%s" : "%s, ", THEME_NAME);
        memcpy(out + n, open + 1, cur.len - (open + 1 - cur.data));
        n += cur.len - (open + 1 - cur.data);
    } else {
        // Our entry, with the comma after it, or before it when it's the last one.
        char *from = ours, *to = ours + strlen(THEME_NAME);
        const char *after = to;
        while (after < close && strchr(" \t\r\n", *after)) {
            after++;
        }
        if (*after == ',') {
            to = (char *)after + 1;
            while (to < close && strchr(" \t\r\n", *to)) {
                to++;
            }
        } else {
            while (from > open + 1 && strchr(" \t\r\n", from[-1])) {
                from--;
            }
            if (from[-1] == ',') {
                from--;
            }
        }
        n = from - cur.data;
        memcpy(out, cur.data, n);
        memcpy(out + n, to, cur.len - (to - cur.data));
        n += cur.len - (to - cur.data);
    }
    backup(settings);
    return write_file(settings, out, n) ? 0 : 3;
}

static BOOL CALLBACK close_window(HWND hwnd, LPARAM pid)
{
    DWORD owner = 0;
    GetWindowThreadProcessId(hwnd, &owner);
    if (owner == (DWORD)pid && IsWindowVisible(hwnd)) {
        PostMessageW(hwnd, WM_CLOSE, 0, 0);
    }
    return TRUE;
}

static void ask_to_close(DWORD pid, void *ctx)
{
    (void)ctx;
    EnumWindows(close_window, (LPARAM)pid);
}

// Closes VRCNext the way its X button does, so it saves its settings; prints its path for the
// restart. Forced only when it hasn't closed after 20 seconds.
static int stop_vrcnext(void)
{
    wchar_t path[MAX_PATH] = L"";
    if (!each_named(L"VRCNext.exe", grab_path, path)) {
        return 1;
    }
    each_named(L"VRCNext.exe", ask_to_close, NULL);
    for (int i = 0; i < 40 && each_named(L"VRCNext.exe", NULL, NULL); i++) {
        Sleep(500);
    }
    each_named(L"VRCNext.exe", stop, NULL);
    wprintf(L"%ls", path);
    return 0;
}

static int start(const wchar_t *path)
{
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
    if (argc >= 4 && argc <= 6 && !wcscmp(argv[1], L"install")) {
        int share = 1, reset = 0;
        for (int i = 4; i < argc; i++) {
            if (!wcscmp(argv[i], L"share=0")) share = 0;
            if (!wcscmp(argv[i], L"reset=1")) reset = 1;
        }
        return install(argv[2], argv[3], share, reset);
    }
    if (argc == 3 && !wcscmp(argv[1], L"uninstall")) {
        return uninstall(argv[2]);
    }
    if ((argc == 2 || argc == 3) && !wcscmp(argv[1], L"running")) {
        return each_named(argc == 3 ? argv[2] : L"VRCX.exe", NULL, NULL) ? 0 : 1;
    }
    if (argc >= 4 && argc <= 6 && !wcscmp(argv[1], L"theme")) {
        int share = 1, reset = 0;
        for (int i = 4; i < argc; i++) {
            if (!wcscmp(argv[i], L"share=0")) share = 0;
            if (!wcscmp(argv[i], L"reset=1")) reset = 1;
        }
        return write_theme(argv[2], argv[3], share, reset);
    }
    if (argc == 3 && !wcscmp(argv[1], L"theme-remove")) {
        return remove_theme(argv[2]);
    }
    if (argc == 4 && !wcscmp(argv[1], L"vrcnext-theme")) {
        return switch_theme(!wcscmp(argv[2], L"on"), argv[3]);
    }
    if (argc == 2 && !wcscmp(argv[1], L"stop-vrcnext")) {
        return stop_vrcnext();
    }
    if (argc == 3 && !wcscmp(argv[1], L"start")) {
        return start(argv[2]);
    }
    if (argc == 2 && !wcscmp(argv[1], L"restart")) {
        return restart();
    }
    fwprintf(stderr, L"usage: botblocker-helper install <custom.js> <plugin.js> | uninstall <custom.js> | running [app.exe] | restart"
                     L" | theme <dir> <plugin.js> | theme-remove <dir> | vrcnext-theme on|off <settings.json> | stop-vrcnext | start <exe>\n");
    return 64;
}
