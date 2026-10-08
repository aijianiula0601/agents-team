# Android 原生更新

`ChorusUpdatesPlugin` 提供 `getUpdateInfo()`、`downloadUpdate({ relayUrl, release })` 和 `updateProgress` 事件。原生版本来自已安装 APK；Web 页面仅传选择的发布编号，原生重新从可信源读取清单。状态包括 downloading、verifying、ready、installing、error；进度字段为 received、total、percent、message。

可信源由 `res/values/strings.xml` 的 `update_relay_url` 在原生构建中指定为自建中转站地址；未配置时拒绝下载，网页配置不能改变安装源。仅可调试 APK 允许回环 HTTP 测试，可通过 `adb reverse` 连接本机服务。清单和下载的每次重定向都必须同源。

APK 流式写入私有缓存，大小上限 2 GiB，校验 SHA-256、包名 `com.chorus.app`、版本名、严格增加的 versionCode 及当前 APK 签名。新包必须沿用旧包的签名证书，Debug/Release 或更换签名证书不能相互覆盖。缓存完整后原子改名，通过仅共享 updates 缓存目录的 FileProvider 打开系统安装器。Android 8 以上缺少未知来源安装授权时打开系统授权页，返回后再次校验并继续安装；用户仍需确认系统安装。

下载与校验在独立单线程执行，连接超时 15 秒、读取超时 30 秒、下载总时长最多 30 分钟；同一时间仅一个任务，临时文件失败清理。下载缓存固定为一个 APK，重复安装将覆盖该缓存。

接口依据：[Capacitor Android 插件](https://capacitorjs.com/docs/plugins/android)、[Android PackageManager](https://developer.android.com/reference/android/content/pm/PackageManager)、[FileProvider](https://developer.android.com/reference/androidx/core/content/FileProvider)。
