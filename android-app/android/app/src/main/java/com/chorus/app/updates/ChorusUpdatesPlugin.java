package com.chorus.app.updates;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;
import androidx.core.content.FileProvider;
import androidx.core.content.pm.PackageInfoCompat;
import com.chorus.app.R;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

/**
 * Android 应用更新桥。
 * 功能：从原生可信中转站下载 APK，校验完整性和签名后打开系统安装器。
 * 参数：桥接调用提供 relayUrl、release；返回状态并发送 updateProgress 事件。
 * 注意事项：不静默安装；所有网络和校验在单独线程执行，页面传入文件地址不作为可信依据。
 */
@CapacitorPlugin(name = "ChorusUpdates")
public class ChorusUpdatesPlugin extends Plugin {
    private static final String TAG = "ChorusUpdates";
    private static final long MAX_PACKAGE_SIZE = 2L * 1024 * 1024 * 1024;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean active = new AtomicBoolean(false);
    private volatile boolean waitingPermission;
    private volatile File pendingFile;
    private volatile JSONObject pendingRelease;
    private volatile long received;
    private volatile long total;
    private volatile boolean destroyed;

    /** 读取本机版本；参数为桥接调用；返回平台、架构、版本与构建号；以已安装 APK 信息为准。 */
    @PluginMethod
    public void getUpdateInfo(PluginCall call) {
        try {
            PackageInfo installed = installedPackage();
            JSObject result = new JSObject();
            result.put("platform", "android");
            result.put("arch", "universal");
            result.put("version", installed.versionName);
            result.put("buildNumber", PackageInfoCompat.getLongVersionCode(installed));
            call.resolve(result);
        } catch (Exception error) {
            Log.e(TAG, "读取安装版本失败", error);
            call.reject("无法读取当前安装版本");
        }
    }

    /**
     * 发起更新；参数为 relayUrl 与 release.id；返回安装器或授权等待状态。
     * 注意事项：原生重新请求发布清单，只接受一个任务；异常清除未完成文件，允许用户重试。
     */
    @PluginMethod
    public void downloadUpdate(PluginCall call) {
        if (!active.compareAndSet(false, true)) {
            call.reject("已有更新正在处理，请稍候");
            return;
        }
        received = 0;
        total = 0;
        worker.execute(() -> {
            File partial = null;
            try {
                // ------------ 从原生可信源重新获取发布清单 ---------------
                Log.i(TAG, "------------- 校验 Android 更新清单 --------------");
                URL base = trustedRelay(call.getString("relayUrl"));
                JSObject requested = call.getObject("release");
                if (requested == null || requested.optString("id").isEmpty()) throw new IOException("更新版本无效，请重新检查更新");
                PackageInfo installed = installedPackage();
                URL manifest = new URL(base + "/api/v1/releases/latest?platform=android&arch=universal&currentVersion=" + Uri.encode(installed.versionName) + "&currentBuild=" + PackageInfoCompat.getLongVersionCode(installed));
                JSONObject release = readManifest(manifest, base).optJSONObject("release");
                if (release == null || !requested.optString("id").equals(release.optString("id")) || !"android".equals(release.optString("platform")) || !"universal".equals(release.optString("arch")) || release.optLong("buildNumber") <= PackageInfoCompat.getLongVersionCode(installed) || !sameOrNewerVersion(release.optString("version"), installed.versionName)) throw new IOException("更新版本已变化或不适用于本机，请重新检查更新");
                total = release.optLong("size");
                if (total <= 0 || total > MAX_PACKAGE_SIZE || !release.optString("sha256").matches("(?i)[a-f0-9]{64}") || !release.optString("fileName").toLowerCase(Locale.ROOT).endsWith(".apk") || release.optString("downloadUrl").isEmpty()) throw new IOException("更新清单的文件信息无效");
                File directory = new File(getContext().getCacheDir(), "updates");
                if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建更新缓存目录");
                partial = new File(directory, "download.part.apk");
                File destination = new File(directory, "Chorus-update.apk");
                Log.i(TAG, "------------- 下载 Android 更新 " + release.optString("version") + "，" + total + " 字节 --------------");
                download(new URL(new URL(base + "/"), release.getString("downloadUrl")), base, partial, release);
                progress("verifying", "正在校验安装包和应用签名");
                verifyPackage(partial, release);
                // 相同私有目录中的 rename 是原子操作，系统安装器不会看到部分 APK。
                if (!partial.renameTo(destination)) throw new IOException("无法保存完整安装包");
                partial = null;
                pendingFile = destination;
                pendingRelease = release;
                progress("ready", "安装包已下载并通过校验");
                getActivity().runOnUiThread(() -> openInstaller(call));
            } catch (Exception error) {
                if (partial != null && partial.exists() && !partial.delete()) Log.w(TAG, "未能清理更新临时文件");
                fail(call, error);
            }
        });
    }

    /** 校验可信更新源；参数为页面地址；返回规范 URL；注意事项：生产仅允许构建内显式配置的 HTTPS 源，调试允许回环 HTTP。 */
    private URL trustedRelay(String value) throws Exception {
        if (value == null || value.length() > 2048) throw new IOException("更新服务地址无效");
        URL base = new URL(value.replaceAll("/+$", ""));
        boolean local = "127.0.0.1".equals(base.getHost()) || "localhost".equalsIgnoreCase(base.getHost()) || "[::1]".equals(base.getHost());
        boolean development = (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        boolean localDevelopment = development && local && "http".equals(base.getProtocol());
        if (base.getUserInfo() != null || base.getQuery() != null || base.getRef() != null || (!"https".equals(base.getProtocol()) && !localDevelopment)) throw new IOException("更新服务必须使用可信 HTTPS 地址");
        // ------------ 未配置原生可信源时，正式安装包不能接受网页传入的下载站 ---------------
        String trustedSource = getContext().getString(R.string.update_relay_url).replaceAll("/+$", "");
        if (trustedSource.isEmpty() && !localDevelopment) throw new IOException("请先配置原生可信更新源");
        if (!trustedSource.isEmpty() && !base.toExternalForm().equals(new URL(trustedSource).toExternalForm()) && !localDevelopment) throw new IOException("该中转站尚未配置为原生可信更新源");
        return base;
    }

    /** 请求同源资源；参数为地址和可信源；返回打开的连接；每次跳转都检查协议、主机和端口，调用者负责关闭。 */
    private HttpURLConnection connection(URL target, URL base) throws Exception {
        URL current = target;
        for (int redirects = 0; redirects <= 4; redirects++) {
            int currentPort = current.getPort() < 0 ? current.getDefaultPort() : current.getPort();
            int basePort = base.getPort() < 0 ? base.getDefaultPort() : base.getPort();
            if (!current.getProtocol().equals(base.getProtocol()) || !current.getHost().equalsIgnoreCase(base.getHost()) || currentPort != basePort || current.getUserInfo() != null || current.getRef() != null) throw new IOException("更新下载地址或重定向不可信");
            HttpURLConnection request = (HttpURLConnection) current.openConnection();
            request.setConnectTimeout(15000);
            request.setReadTimeout(30000);
            request.setInstanceFollowRedirects(false);
            request.setRequestProperty("Accept-Encoding", "identity");
            int status;
            try { status = request.getResponseCode(); }
            catch (Exception error) { request.disconnect(); throw error; }
            if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                String location = request.getHeaderField("Location");
                request.disconnect();
                if (location == null) throw new IOException("更新服务重定向缺少地址");
                current = new URL(current, location);
                continue;
            }
            if (status != 200) { request.disconnect(); throw new IOException("更新服务响应异常（" + status + "）"); }
            return request;
        }
        throw new IOException("更新服务重定向次数过多");
    }

    /** 读取有限大小清单；参数为清单地址和可信源；返回 JSON；限制一 MiB 防止耗尽内存。 */
    private JSONObject readManifest(URL address, URL base) throws Exception {
        HttpURLConnection request = connection(address, base);
        long deadline = SystemClock.elapsedRealtime() + 60000;
        try (InputStream input = request.getInputStream(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (bytes.size() + count > 1024 * 1024 || SystemClock.elapsedRealtime() > deadline) throw new IOException("更新清单过大或响应超时");
                bytes.write(buffer, 0, count);
            }
            return new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
        } finally { request.disconnect(); }
    }

    /** 流式下载并计算摘要；参数为地址、源、临时文件和发布清单；无返回值；限制大小、半小时总时长和三十秒读超时。 */
    private void download(URL address, URL base, File file, JSONObject release) throws Exception {
        HttpURLConnection request = connection(address, base);
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        long deadline = SystemClock.elapsedRealtime() + 30 * 60 * 1000;
        long lastProgress = 0;
        try {
            long declaredSize = request.getContentLengthLong();
            if (declaredSize >= 0 && declaredSize != total) throw new IOException("安装包大小与发布清单不一致");
            progress("downloading", null);
            try (InputStream input = request.getInputStream(); FileOutputStream output = new FileOutputStream(file)) {
                byte[] buffer = new byte[65536];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    received += count;
                    if (received > total) throw new IOException("安装包超过声明大小");
                    if (Thread.currentThread().isInterrupted() || SystemClock.elapsedRealtime() > deadline) throw new IOException("更新下载超时，请重试");
                    output.write(buffer, 0, count);
                    hash.update(buffer, 0, count);
                    if (SystemClock.elapsedRealtime() - lastProgress > 250) { progress("downloading", null); lastProgress = SystemClock.elapsedRealtime(); }
                }
                output.getFD().sync();
            }
            if (received != total || !hex(hash.digest()).equalsIgnoreCase(release.getString("sha256"))) throw new IOException("安装包完整性校验失败，请重新下载");
        } finally { request.disconnect(); }
    }

    /** 获取当前 APK 元信息；无参数；返回包含签名的包信息；低版本 Android 使用兼容标记。 */
    @SuppressWarnings("deprecation")
    private PackageInfo installedPackage() throws PackageManager.NameNotFoundException {
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        return getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), flags);
    }

    /** 检查版本名不回退；参数为候选和当前版本；返回是否相同或更高；仅接受 x.y.z 正式版本，同版本仍要求构建号增加。 */
    private boolean sameOrNewerVersion(String next, String current) {
        String pattern = "(0|[1-9]\\d{0,8})\\.(0|[1-9]\\d{0,8})\\.(0|[1-9]\\d{0,8})";
        if (next == null || current == null || !next.matches(pattern) || !current.matches(pattern)) return false;
        String[] candidate = next.split("\\.");
        String[] installed = current.split("\\.");
        for (int index = 0; index < candidate.length; index++) {
            int difference = Integer.compare(Integer.parseInt(candidate[index]), Integer.parseInt(installed[index]));
            if (difference != 0) return difference > 0;
        }
        return true;
    }

    /** 校验覆盖安装身份；参数为 APK 和原生清单；无返回值；包名、版本名、构建号及当前签名必须一致。 */
    @SuppressWarnings("deprecation")
    private void verifyPackage(File file, JSONObject release) throws Exception {
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo candidate = getContext().getPackageManager().getPackageArchiveInfo(file.getAbsolutePath(), flags);
        PackageInfo installed = installedPackage();
        if (candidate == null || !getContext().getPackageName().equals(candidate.packageName)) throw new IOException("安装包不是 Chorus 应用");
        if (candidate.applicationInfo != null && candidate.applicationInfo.minSdkVersion > Build.VERSION.SDK_INT) throw new IOException("新版本不支持当前 Android 系统，请升级系统后重试");
        if (!release.getString("version").equals(candidate.versionName) || !sameOrNewerVersion(candidate.versionName, installed.versionName) || PackageInfoCompat.getLongVersionCode(candidate) != release.getLong("buildNumber") || PackageInfoCompat.getLongVersionCode(candidate) <= PackageInfoCompat.getLongVersionCode(installed)) throw new IOException("APK 版本信息与发布清单不一致或版本过旧");
        Set<String> currentSigners = signatures(installed);
        Set<String> nextSigners = signatures(candidate);
        if (currentSigners.isEmpty() || !currentSigners.equals(nextSigners)) throw new IOException("APK 签名与当前应用不一致，不能覆盖安装");
        Log.i(TAG, "APK 包名、版本和签名已验证，构建号=" + PackageInfoCompat.getLongVersionCode(candidate));
    }

    /** 提取当前签名摘要集合；参数为包信息；返回 SHA-256 集合；多签名必须逐个匹配，不接受未知签名。 */
    @SuppressWarnings("deprecation")
    private Set<String> signatures(PackageInfo info) throws Exception {
        Signature[] certificates = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? (info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners()) : info.signatures;
        Set<String> result = new HashSet<>();
        if (certificates != null) for (Signature certificate : certificates) result.add(hex(MessageDigest.getInstance("SHA-256").digest(certificate.toByteArray())));
        return result;
    }

    /** 编码摘要；参数为字节数组；返回小写十六进制；不输出或保存密钥。 */
    private String hex(byte[] value) {
        StringBuilder encoded = new StringBuilder(value.length * 2);
        for (byte item : value) { encoded.append(Character.forDigit((item >>> 4) & 15, 16)); encoded.append(Character.forDigit(item & 15, 16)); }
        return encoded.toString();
    }

    /** 打开系统授权或安装器；参数为可空桥接调用；返回桥接状态；仅在 UI 线程执行，不绕过系统安装确认。 */
    private void openInstaller(PluginCall call) {
        try {
            if (destroyed || getActivity() == null || getActivity().isFinishing()) throw new IOException("应用已关闭，请重新打开后更新");
            if (pendingFile == null || !pendingFile.isFile()) throw new IOException("安装包已失效，请重新下载");
            JSObject result = new JSObject();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
                waitingPermission = true;
                Intent permission = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
                getActivity().startActivity(permission);
                progress("ready", "请允许 Chorus 安装应用，返回后将继续安装");
                result.put("status", "ready");
                result.put("permissionRequired", true);
            } else {
                waitingPermission = false;
                Uri file = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".updates.fileprovider", pendingFile);
                Intent install = new Intent(Intent.ACTION_VIEW);
                install.setDataAndType(file, "application/vnd.android.package-archive");
                install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getActivity().startActivity(install);
                progress("installing", "请在系统安装界面确认更新");
                result.put("status", "installing");
                active.set(false);
                Log.i(TAG, "------------- 已打开 Android 系统安装器 --------------");
            }
            if (call != null) call.resolve(result);
        } catch (Exception error) { fail(call, error); }
    }

    /** 授权页面返回后继续安装；无参数、无返回值；重新校验缓存摘要和 APK 身份，授权拒绝时允许重试。 */
    @Override
    protected void handleOnResume() {
        if (!waitingPermission) return;
        waitingPermission = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            fail(null, new IOException("未允许安装应用，可再次点击更新后授权"));
            return;
        }
        worker.execute(() -> {
            try {
                File file = pendingFile;
                JSONObject release = pendingRelease;
                if (file == null || release == null || file.length() != release.getLong("size")) throw new IOException("安装包缓存已失效，请重新下载");
                MessageDigest hash = MessageDigest.getInstance("SHA-256");
                try (InputStream input = new FileInputStream(file)) {
                    byte[] buffer = new byte[65536];
                    int count;
                    while ((count = input.read(buffer)) != -1) hash.update(buffer, 0, count);
                }
                if (!hex(hash.digest()).equalsIgnoreCase(release.getString("sha256"))) throw new IOException("安装包缓存校验失败，请重新下载");
                verifyPackage(file, release);
                getActivity().runOnUiThread(() -> openInstaller(null));
            } catch (Exception error) { fail(null, error); }
        });
    }

    /** 发布更新进度；参数为阶段和提示；无返回值；节流由下载线程负责，日志和事件不包含认证信息。 */
    private void progress(String status, String message) {
        if (destroyed) return;
        JSObject event = new JSObject();
        event.put("status", status);
        event.put("received", received);
        event.put("total", total);
        event.put("percent", total > 0 ? Math.min(100, received * 100 / total) : 0);
        if (message != null) event.put("message", message);
        notifyListeners("updateProgress", event);
    }

    /** 结束失败任务；参数为可空调用和异常；无返回值；恢复可重试状态且记录原生异常。 */
    private void fail(PluginCall call, Exception error) {
        waitingPermission = false;
        active.set(false);
        String message = error instanceof IOException ? error.getMessage() : "更新失败，请检查网络或联系管理员";
        Log.e(TAG, "Android 更新失败", error);
        progress("error", message);
        if (call != null) call.reject(message);
    }

    /** 销毁后台线程；无参数、无返回值；生命周期结束后不再启动安装流程。 */
    @Override
    protected void handleOnDestroy() {
        destroyed = true;
        waitingPermission = false;
        worker.shutdownNow();
    }
}
